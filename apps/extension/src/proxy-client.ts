import {
  ErrorResponseSchema,
  ListOrdersResponseSchema,
  MAX_EMAIL_BYTES,
  type OrderRecord,
  type ParseRequest,
  type ParseResponse,
  ParseResponseSchema,
} from "@oep/shared";
import type { z } from "zod";
import { ExtensionError } from "./errors.ts";

const FRIENDLY: Record<string, string> = {
  forbidden_origin:
    "The proxy rejected this extension. Check ALLOWED_ORIGINS in apps/server/.env matches this extension's ID.",
  upstream_rate_limited: "Gemini rate limit reached. Wait a moment and try again.",
  upstream_timeout: "Gemini took too long to answer. Try again.",
  email_not_allowed:
    "Skipped: only emails from Mytheresa, Selfridges, Revolve or with [TEST ORDER] in the subject are parsed.",
};

export interface ProxyOptions {
  proxyUrl?: string;
  fetch?: typeof fetch;
}

/** Calls the proxy and validates the response. The Google access token is never sent. */
async function call<S extends z.ZodType>(
  path: string,
  init: RequestInit,
  schema: S,
  opts: ProxyOptions,
): Promise<z.infer<S>> {
  const proxyUrl = opts.proxyUrl ?? import.meta.env.PROXY_URL;
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);

  let res: Response;
  try {
    res = await doFetch(`${proxyUrl}${path}`, init);
  } catch {
    throw new ExtensionError(
      "proxy_unreachable",
      `Cannot reach the parsing proxy at ${proxyUrl}. Is \`pnpm dev:server\` running?`,
    );
  }

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = ErrorResponseSchema.safeParse(body);
    if (!error.success) {
      throw new ExtensionError("proxy_error", `Proxy returned HTTP ${res.status}`);
    }
    const { code, message } = error.data.error;
    throw new ExtensionError("proxy_error", FRIENDLY[code] ?? message);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ExtensionError("proxy_error", "Proxy returned an unexpected response shape");
  }
  return parsed.data;
}

/** Parses one email (or returns it from the history DB if it was parsed before). */
export async function parseEmailViaProxy(
  request: ParseRequest,
  opts: ProxyOptions = {},
): Promise<ParseResponse> {
  const { email } = request;
  const size = new TextEncoder().encode((email.html ?? "") + (email.text ?? "")).length;
  if (size > MAX_EMAIL_BYTES) {
    throw new ExtensionError(
      "email_too_large",
      `Email is ${Math.round(size / 1024)} KB; the limit is ${MAX_EMAIL_BYTES / 1000} KB.`,
    );
  }
  return call(
    "/v1/parse",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
    ParseResponseSchema,
    opts,
  );
}

/** Full parse history for one Gmail account, newest first. */
export async function listOrders(account: string, opts: ProxyOptions = {}): Promise<OrderRecord[]> {
  const { records } = await call(
    "/v1/orders/list",
    {
      // POST, not GET: Chrome only sends the Origin header the proxy checks on POSTs.
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account }),
    },
    ListOrdersResponseSchema,
    opts,
  );
  return records;
}
