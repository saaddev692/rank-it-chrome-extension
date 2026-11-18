import {
  type ErrorCode,
  type ErrorResponse,
  ListOrdersRequestSchema,
  type ListOrdersResponse,
  MAX_EMAIL_BYTES,
  type OrderRecord,
  ParseRequestSchema,
  type ParseResponse,
  isAllowedOrderEmail,
} from "@oep/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { AppError } from "./errors.ts";
import type { StructuredExtractor } from "./gemini.ts";
import { parseOrderEmail } from "./parse-order.ts";
import type { OrderStore } from "./store.ts";

export interface AppDeps {
  allowedOrigins: readonly string[];
  extractor: StructuredExtractor;
  store: OrderStore;
  log?: (msg: string) => void;
  now?: () => Date;
}

function errorBody(code: ErrorCode, message: string): ErrorResponse {
  return { error: { code, message } };
}

function firstIssue(error: z.ZodError, fallback: string): string {
  const first = error.issues[0];
  return `${first?.path.join(".") || fallback}: ${first?.message ?? "invalid"}`;
}

/** Short, non-reversible label for logs so message IDs and addresses don't end up in them. */
function tag(value: string): string {
  let h = 0;
  for (const ch of value) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function createApp(deps: AppDeps): Hono {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, model: deps.extractor.model }));

  app.use(
    "/v1/*",
    cors({
      origin: (origin) =>
        deps.allowedOrigins.includes(origin) ? origin : null,
      allowMethods: ["POST"],
      allowHeaders: ["Content-Type"],
      maxAge: 600,
    }),
  );

  // Chrome always sends Origin on POSTs from extension pages and service workers, so this blocks
  // any web page from reading the history or spending the Gemini quota through localhost. Every
  // /v1 route is a POST on purpose: Chrome omits Origin on extension GETs to hosts the extension
  // has permission for, which would make GETs indistinguishable from a local script.
  app.use("/v1/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const origin = c.req.header("Origin");
    if (!origin || !deps.allowedOrigins.includes(origin)) {
      return c.json(errorBody("forbidden_origin", "Origin not allowed"), 403);
    }
    return next();
  });

  app.post(
    "/v1/parse",
    bodyLimit({
      maxSize: MAX_EMAIL_BYTES * 2,
      onError: (e) =>
        e.json(
          errorBody("payload_too_large", "Email is too large to parse"),
          413,
        ),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(errorBody("bad_request", "Body must be JSON"), 400);
      }
      const parsed = ParseRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          errorBody("bad_request", firstIssue(parsed.error, "body")),
          400,
        );
      }
      const { account, source, force, email } = parsed.data;
      if (!isAllowedOrderEmail(email)) {
        return c.json(
          errorBody(
            "email_not_allowed",
            "Only emails from a supported retailer domain or with [TEST ORDER] in the subject are parsed",
          ),
          422,
        );
      }
      const label = `${tag(account)}/${tag(email.messageId)}`;

      if (!force) {
        const existing = deps.store.get(account, email.messageId);
        if (existing) {
          log(`history hit ${label}`);
          return c.json({
            record: existing,
            cached: true,
          } satisfies ParseResponse);
        }
      }

      const started = Date.now();
      const order = await parseOrderEmail(email, deps.extractor);
      const record: OrderRecord = {
        account,
        messageId: email.messageId,
        from: email.from,
        subject: email.subject,
        emailDate: email.date,
        source,
        model: deps.extractor.model,
        parsedAt: now().toISOString(),
        order,
      };
      deps.store.upsert(record);
      log(
        `parsed ${label} source=${source} items=${order.items.length} in ${Date.now() - started} ms`,
      );
      return c.json({ record, cached: false } satisfies ParseResponse);
    },
  );

  app.post("/v1/orders/list", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("bad_request", "Body must be JSON"), 400);
    }
    const parsed = ListOrdersRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        errorBody("bad_request", firstIssue(parsed.error, "body")),
        400,
      );
    }
    // Records saved before the strict sender rule existed are hidden rather than shown as orders.
    const records = deps.store
      .list(parsed.data.account, parsed.data.limit)
      .filter((r) => isAllowedOrderEmail(r));
    return c.json({ records } satisfies ListOrdersResponse);
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      log(`error ${err.code}: ${err.message}`);
      return c.json(
        errorBody(err.code, err.message),
        err.status as ContentfulStatusCode,
      );
    }
    log(`unexpected error: ${err.stack ?? err.message}`);
    return c.json(errorBody("internal_error", "Unexpected server error"), 500);
  });

  app.notFound((c) => c.json(errorBody("bad_request", "Not found"), 404));

  return app;
}
