import {
  type EmailPayload,
  MAX_EMAIL_BYTES,
  type OrderRecord,
  type ParseRequest,
  type ParseResponse,
} from "@oep/shared";
import { describe, expect, it, vi } from "vitest";
import { listOrders, parseEmailViaProxy } from "./proxy-client.ts";

const email: EmailPayload = {
  messageId: "m1",
  from: "orders@selfridges.com",
  subject: "Thanks for your order",
  date: null,
  html: "<p>order</p>",
  text: null,
};

const request = (overrides: Partial<EmailPayload> = {}): ParseRequest => ({
  account: "me@gmail.com",
  source: "manual",
  email: { ...email, ...overrides },
});

const record: OrderRecord = {
  account: "me@gmail.com",
  messageId: "m1",
  from: email.from,
  subject: email.subject,
  emailDate: null,
  source: "manual",
  model: "gemini-3.8-flash",
  parsedAt: "2026-11-18T10:00:00.000Z",
  order: {
    isOrderConfirmation: true,
    retailer: "Selfridges",
    orderNumber: "1",
    orderDate: "2026-09-14",
    currency: "GBP",
    total: 10,
    items: [],
  },
};
const ok: ParseResponse = { record, cached: false };

const opts = (f: typeof fetch) => ({ proxyUrl: "http://127.0.0.1:8787", fetch: f });

describe("parseEmailViaProxy", () => {
  it("posts account, source and email as JSON without any Authorization header", async () => {
    const f = vi.fn<typeof fetch>(async () => Response.json(ok));
    await expect(parseEmailViaProxy(request(), opts(f))).resolves.toEqual(ok);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/parse");
    expect(JSON.parse(init?.body as string)).toEqual(request());
    expect(Object.keys(init?.headers as Record<string, string>)).toEqual(["Content-Type"]);
  });

  it("passes force through for re-parses", async () => {
    const f = vi.fn<typeof fetch>(async () => Response.json(ok));
    await parseEmailViaProxy({ ...request(), force: true }, opts(f));
    expect(JSON.parse(f.mock.calls[0]![1]?.body as string)).toMatchObject({ force: true });
  });

  it("uses the build-time proxy URL by default", async () => {
    const f = vi.fn<typeof fetch>(async () => Response.json(ok));
    await parseEmailViaProxy(request(), { fetch: f });
    expect(f.mock.calls[0]![0]).toBe("http://127.0.0.1:8787/v1/parse");
  });

  it("refuses emails over the size limit without calling the proxy", async () => {
    const f = vi.fn<typeof fetch>();
    await expect(
      parseEmailViaProxy(request({ html: "x".repeat(MAX_EMAIL_BYTES + 1) }), opts(f)),
    ).rejects.toMatchObject({ kind: "email_too_large" });
    expect(f).not.toHaveBeenCalled();
  });

  it("measures size in bytes, not characters", async () => {
    const f = vi.fn<typeof fetch>();
    const multiByte = "€".repeat(Math.ceil(MAX_EMAIL_BYTES / 3) + 1);
    await expect(parseEmailViaProxy(request({ html: multiByte }), opts(f))).rejects.toMatchObject({
      kind: "email_too_large",
    });
  });

  it("explains how to start the proxy when it is unreachable", async () => {
    const f = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    const err = await parseEmailViaProxy(request(), opts(f)).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "proxy_unreachable" });
    expect((err as Error).message).toContain("pnpm dev:server");
  });

  it("turns forbidden_origin into setup guidance", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { code: "forbidden_origin", message: "Origin not allowed" } },
        { status: 403 },
      ),
    );
    await expect(parseEmailViaProxy(request(), opts(f))).rejects.toThrow("ALLOWED_ORIGINS");
  });

  it("explains the sender rule when the proxy refuses an email", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { code: "email_not_allowed", message: "x" } }, { status: 422 }),
    );
    await expect(parseEmailViaProxy(request(), opts(f))).rejects.toThrow("[TEST ORDER]");
  });

  it("passes through the proxy's message for other error codes", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { code: "invalid_model_output", message: "Model output failed validation" } },
        { status: 502 },
      ),
    );
    await expect(parseEmailViaProxy(request(), opts(f))).rejects.toThrow(
      "Model output failed validation",
    );
  });

  it("handles non-JSON error bodies", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response("Bad Gateway", { status: 502 }));
    await expect(parseEmailViaProxy(request(), opts(f))).rejects.toThrow("HTTP 502");
  });

  it("rejects a 200 response with an unexpected shape", async () => {
    const f = vi.fn<typeof fetch>(async () => Response.json({ order: { brand: "x" } }));
    await expect(parseEmailViaProxy(request(), opts(f))).rejects.toMatchObject({
      kind: "proxy_error",
    });
  });
});

describe("listOrders", () => {
  it("POSTs the account so Chrome sends the Origin header the proxy requires", async () => {
    const f = vi.fn<typeof fetch>(async () => Response.json({ records: [record] }));
    await expect(listOrders("me+test@gmail.com", opts(f))).resolves.toEqual([record]);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/orders/list");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ account: "me+test@gmail.com" });
  });

  it("rejects a malformed history response", async () => {
    const f = vi.fn<typeof fetch>(async () => Response.json({ records: [{ nope: true }] }));
    await expect(listOrders("me@gmail.com", opts(f))).rejects.toMatchObject({
      kind: "proxy_error",
    });
  });

  it("maps proxy errors", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { code: "bad_request", message: "account: invalid" } },
        { status: 400 },
      ),
    );
    await expect(listOrders("me@gmail.com", opts(f))).rejects.toThrow("account: invalid");
  });
});
