import {
  type EmailPayload,
  type ParsedOrder,
  ParsedOrderSchema,
  detectRetailer,
} from "@oep/shared";
import { AppError } from "./errors.ts";
import type { StructuredExtractor } from "./gemini.ts";
import { preprocessEmail } from "./preprocess.ts";
import { buildUserInput } from "./prompt.ts";

function normaliseCurrency(value: unknown): unknown {
  return typeof value === "string" ? value.trim().toUpperCase() : value;
}

function emptyToNull(v: unknown): unknown {
  return typeof v === "string" && v.trim() === "" ? null : v;
}

/** Coerces harmless model quirks (lowercase currency, empty strings) before strict validation. */
function normaliseRaw(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const order = raw as Record<string, unknown>;
  const items = Array.isArray(order["items"]) ? (order["items"] as unknown[]) : order["items"];
  return {
    ...order,
    retailer: emptyToNull(order["retailer"]),
    orderNumber: emptyToNull(order["orderNumber"]),
    orderDate: emptyToNull(order["orderDate"]),
    currency: normaliseCurrency(emptyToNull(order["currency"])),
    items: Array.isArray(items)
      ? items.map((item) => {
          if (typeof item !== "object" || item === null) return item;
          const it = item as Record<string, unknown>;
          return {
            ...it,
            brand: emptyToNull(it["brand"]),
            colour: emptyToNull(it["colour"]),
            size: emptyToNull(it["size"]),
            currency: normaliseCurrency(emptyToNull(it["currency"])),
            imageUrl: emptyToNull(it["imageUrl"]),
          };
        })
      : items,
  };
}

export async function parseOrderEmail(
  email: EmailPayload,
  extractor: StructuredExtractor,
): Promise<ParsedOrder> {
  const detectedRetailer = detectRetailer(email.from);
  const pre = preprocessEmail({ html: email.html, text: email.text });

  const raw = await extractor.extract(
    buildUserInput({
      from: email.from,
      subject: email.subject,
      date: email.date,
      detectedRetailer,
      body: pre.text,
      truncated: pre.truncated,
    }),
  );

  const result = ParsedOrderSchema.safeParse(normaliseRaw(raw));
  if (!result.success) {
    const first = result.error.issues[0];
    throw new AppError(
      "invalid_model_output",
      502,
      `Model output failed validation at "${first?.path.join(".") ?? "?"}": ${first?.message ?? "unknown"}`,
    );
  }
  const order = result.data;

  // The sender domain is authoritative; the model only fills in the retailer when the domain is unknown.
  order.retailer = detectedRetailer ?? order.retailer;
  // Anti-hallucination: only accept image URLs that literally appear in the email.
  for (const item of order.items) {
    if (item.imageUrl !== null && !pre.imageUrls.has(item.imageUrl)) item.imageUrl = null;
  }
  return order;
}
