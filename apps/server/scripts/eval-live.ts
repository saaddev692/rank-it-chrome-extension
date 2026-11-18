import { FIXTURE_NAMES, loadFixture } from "../src/test-helpers.ts";
/**
 * Runs the three retailer fixtures through the real Gemini API and compares the result with
 * the expected JSON. Costs a few API calls; not part of `pnpm test`.
 *
 *   pnpm eval:live            (reads GEMINI_API_KEY / GEMINI_MODEL from apps/server/.env)
 */
import type { OrderItem, ParsedOrder } from "@oep/shared";

import { createGeminiExtractor } from "../src/gemini.ts";
import { parseOrderEmail } from "../src/parse-order.ts";

const apiKey = process.env["GEMINI_API_KEY"];
if (!apiKey) {
  console.error("GEMINI_API_KEY is not set (apps/server/.env).");
  process.exit(1);
}

const extractor = createGeminiExtractor({
  apiKey,
  model: process.env["GEMINI_MODEL"] || "gemini-3.8-flash",
  apiRevision: process.env["GEMINI_API_REVISION"] || "2026-05-20",
  timeoutMs: 60_000,
});

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);

function diffItem(prefix: string, got: OrderItem | undefined, want: OrderItem): string[] {
  if (!got) return [`${prefix}: missing`];
  const keys = [
    "name",
    "brand",
    "colour",
    "size",
    "quantity",
    "price",
    "currency",
    "imageUrl",
  ] as const;
  return keys
    .filter((k) => norm(got[k]) !== norm(want[k]))
    .map((k) => `${prefix}.${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(want[k])}`);
}

function diff(got: ParsedOrder, want: ParsedOrder): string[] {
  const top = (
    ["isOrderConfirmation", "retailer", "orderNumber", "orderDate", "currency", "total"] as const
  )
    .filter((k) => norm(got[k]) !== norm(want[k]))
    .map((k) => `${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(want[k])}`);
  const items = want.items.flatMap((w, i) => diffItem(`items[${i}]`, got.items[i], w));
  const extra =
    got.items.length > want.items.length
      ? [`${got.items.length - want.items.length} unexpected extra item(s)`]
      : [];
  return [...top, ...items, ...extra];
}

let failures = 0;
for (const name of FIXTURE_NAMES) {
  const { email, expected } = loadFixture(name);
  const started = Date.now();
  try {
    // oxlint-disable-next-line no-await-in-loop -- sequential on purpose: keeps per-fixture timings honest and stays under free-tier rate limits.
    const order = await parseOrderEmail(email, extractor);
    const problems = diff(order, expected);
    const ms = Date.now() - started;
    if (problems.length === 0) {
      console.log(`PASS ${name} (${ms} ms)`);
    } else {
      failures++;
      console.log(`FAIL ${name} (${ms} ms)\n  ${problems.join("\n  ")}`);
    }
    if (process.argv.includes("--verbose")) console.log(JSON.stringify(order, null, 2));
  } catch (err) {
    failures++;
    console.log(`ERROR ${name}: ${(err as Error).message}`);
  }
}
process.exit(failures === 0 ? 0 : 1);
