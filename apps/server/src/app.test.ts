import { MAX_EMAIL_BYTES } from "@oep/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { AppError } from "./errors.ts";
import { openOrderStore } from "./store.ts";
import { fakeExtractor, loadFixture } from "./test-helpers.ts";

const ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const ACCOUNT = "me@gmail.com";
const NOW = new Date("2026-11-18T10:00:00.000Z");
const { email, expected } = loadFixture("selfridges");

function setup(result: unknown = expected) {
  const fake = fakeExtractor(result);
  const store = openOrderStore(":memory:");
  const logs: string[] = [];
  const app = createApp({
    allowedOrigins: [ORIGIN],
    extractor: fake.extractor,
    store,
    log: (m) => logs.push(m),
    now: () => NOW,
  });
  return { app, calls: fake.calls, logs, store };
}

type App = ReturnType<typeof setup>["app"];

function post(app: App, body: unknown, headers: Record<string, string> = { Origin: ORIGIN }) {
  return app.request("/v1/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const parseBody = (overrides: Record<string, unknown> = {}) => ({
  account: ACCOUNT,
  source: "manual",
  email,
  ...overrides,
});

function listOrders(app: App, body: unknown, headers: Record<string, string> = { Origin: ORIGIN }) {
  return app.request("/v1/orders/list", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /v1/parse", () => {
  it("parses, stores and returns the record with CORS for the extension", async () => {
    const { app, store } = setup();
    const res = await post(app, parseBody());
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const expectedRecord = {
      account: ACCOUNT,
      messageId: email.messageId,
      from: email.from,
      subject: email.subject,
      emailDate: email.date,
      source: "manual",
      model: "test-model",
      parsedAt: NOW.toISOString(),
      order: expected,
    };
    expect(await res.json()).toEqual({ record: expectedRecord, cached: false });
    expect(store.get(ACCOUNT, email.messageId)).toEqual(expectedRecord);
  });

  it("returns the stored record for a message already in history, without calling Gemini", async () => {
    const { app, calls } = setup();
    await post(app, parseBody({ source: "auto" }));
    const res = await post(app, parseBody());
    const body = (await res.json()) as { cached: boolean; record: { source: string } };
    expect(body.cached).toBe(true);
    expect(body.record.source).toBe("auto");
    expect(calls).toHaveLength(1);
  });

  it("normalises the account so history lookups are case-insensitive", async () => {
    const { app, calls } = setup();
    await post(app, parseBody({ account: "Me@Gmail.com" }));
    await post(app, parseBody({ account: "me@gmail.com" }));
    expect(calls).toHaveLength(1);
  });

  it("re-parses and overwrites when force is true", async () => {
    let total = 1;
    const { app, calls, store } = setup(() => ({ ...expected, total: total++ }));
    await post(app, parseBody());
    const res = await post(app, parseBody({ force: true }));
    expect(await res.json()).toMatchObject({ cached: false, record: { order: { total: 2 } } });
    expect(store.get(ACCOUNT, email.messageId)?.order.total).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("does not store failures", async () => {
    const { app, store } = setup(() => {
      throw new AppError("upstream_error", 502, "boom");
    });
    expect((await post(app, parseBody())).status).toBe(502);
    expect(store.get(ACCOUNT, email.messageId)).toBeNull();
  });

  it.each([
    ["GitHub notification", "GitHub <notifications@github.com>", "Re: [org/repo] Fix test order"],
    ["look-alike domain", "Shop <orders@revolve.com.evil.io>", "Your order is confirmed"],
    ["lowercase tag", "Me <me@gmail.com>", "Your order [test order]"],
  ])("refuses a %s with 422 before calling Gemini or storing", async (_label, from, subject) => {
    const { app, calls, store } = setup();
    const res = await post(app, parseBody({ email: { ...email, from, subject } }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "email_not_allowed" } });
    expect(calls).toHaveLength(0);
    expect(store.list(ACCOUNT)).toEqual([]);
  });

  it("accepts a mock email from any sender when the subject has the [TEST ORDER] tag", async () => {
    const { app, calls } = setup();
    const res = await post(
      app,
      parseBody({
        email: { ...email, from: "REVOLVE <me@gmail.com>", subject: "Your order [TEST ORDER]" },
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["no Origin header", {}],
    ["a web page origin", { Origin: "https://evil.example" }],
    ["another extension", { Origin: `chrome-extension://${"b".repeat(32)}` }],
  ])("rejects %s with 403 and never calls Gemini", async (_label, headers) => {
    const { app, calls } = setup();
    const res = await post(app, parseBody(), headers);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "forbidden_origin", message: "Origin not allowed" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("answers the CORS preflight only for the allowed origin", async () => {
    const { app } = setup();
    const preflight = (origin: string) =>
      app.request("/v1/parse", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
    expect((await preflight(ORIGIN)).headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(
      (await preflight("https://evil.example")).headers.get("access-control-allow-origin"),
    ).toBeNull();
  });

  it.each([
    ["malformed JSON", "{oops"],
    ["missing email", { account: ACCOUNT, source: "manual" }],
    ["missing account", { source: "manual", email }],
    ["invalid account", parseBody({ account: "nope" })],
    ["unknown source", parseBody({ source: "cron" })],
    ["email without a body", parseBody({ email: { ...email, html: null, text: null } })],
    ["wrong field types", parseBody({ email: { ...email, subject: 42 } })],
  ])("rejects %s with 400", async (_label, body) => {
    const { app, calls } = setup();
    const res = await post(app, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
    expect(calls).toHaveLength(0);
  });

  it("rejects oversized emails with 413", async () => {
    const { app, calls } = setup();
    const res = await post(
      app,
      parseBody({ email: { ...email, html: "x".repeat(MAX_EMAIL_BYTES * 2 + 1) } }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "payload_too_large" } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [new AppError("upstream_rate_limited", 429, "slow down"), 429, "upstream_rate_limited"],
    [new AppError("upstream_timeout", 504, "timeout"), 504, "upstream_timeout"],
    [new AppError("invalid_model_output", 502, "bad"), 502, "invalid_model_output"],
  ])("maps %s to its HTTP status", async (error, status, code) => {
    const { app } = setup(() => {
      throw error;
    });
    const res = await post(app, parseBody());
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: { code } });
  });

  it("hides details of unexpected errors from the client but logs them", async () => {
    const { app, logs } = setup(() => {
      throw new Error("secret internal detail");
    });
    const res = await post(app, parseBody());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret internal detail");
    expect(logs.join("\n")).toContain("secret internal detail");
  });

  it("never logs email content, addresses or message ids", async () => {
    const { app, logs } = setup();
    await post(app, parseBody());
    await post(app, parseBody());
    const all = logs.join("\n");
    expect(all).not.toContain("Acne");
    expect(all).not.toContain(email.subject);
    expect(all).not.toContain(ACCOUNT);
    expect(all).not.toContain(email.messageId);
    expect(all).toContain("history hit");
  });
});

describe("POST /v1/orders/list", () => {
  it("returns the account's history, newest first", async () => {
    const { app } = setup();
    await post(app, parseBody());
    await post(app, parseBody({ account: "someone-else@gmail.com" }));
    const res = await listOrders(app, { account: "ME@gmail.com" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const body = (await res.json()) as { records: { account: string; order: unknown }[] };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.account).toBe(ACCOUNT);
    expect(body.records[0]!.order).toEqual(expected);
  });

  it("returns an empty list for an account with no history", async () => {
    const { app } = setup();
    expect(await (await listOrders(app, { account: ACCOUNT })).json()).toEqual({ records: [] });
  });

  it("hides stored records whose sender would not be allowed today", async () => {
    const { app, store } = setup();
    store.upsert({
      account: ACCOUNT,
      messageId: "github-1",
      from: "GitHub <notifications@github.com>",
      subject: "Fix test order",
      emailDate: null,
      source: "manual",
      model: "m",
      parsedAt: NOW.toISOString(),
      order: expected,
    });
    await post(app, parseBody());
    const body = (await (await listOrders(app, { account: ACCOUNT })).json()) as {
      records: { messageId: string }[];
    };
    expect(body.records.map((r) => r.messageId)).toEqual([email.messageId]);
  });

  it.each([
    ["malformed JSON", "{oops"],
    ["missing account", {}],
    ["invalid account", { account: "nope" }],
    ["zero limit", { account: ACCOUNT, limit: 0 }],
    ["fractional limit", { account: ACCOUNT, limit: 1.5 }],
    ["huge limit", { account: ACCOUNT, limit: 99_999 }],
  ])("rejects %s with 400", async (_label, body) => {
    const { app } = setup();
    expect((await listOrders(app, body)).status).toBe(400);
  });

  it("is protected by the origin check", async () => {
    const { app } = setup();
    expect((await listOrders(app, { account: ACCOUNT }, {})).status).toBe(403);
    expect(
      (await listOrders(app, { account: ACCOUNT }, { Origin: "https://evil.example" })).status,
    ).toBe(403);
  });

  it("GET is not supported (Chrome omits Origin on extension GETs)", async () => {
    const { app } = setup();
    const res = await app.request(`/v1/orders/list?account=${ACCOUNT}`, {
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(404);
  });
});

describe("other routes", () => {
  it("GET /healthz reports the model", async () => {
    const { app } = setup();
    expect(await (await app.request("/healthz")).json()).toEqual({ ok: true, model: "test-model" });
  });

  it("unknown routes return 404 JSON", async () => {
    const { app } = setup();
    expect((await app.request("/nope")).status).toBe(404);
  });

  it("GET on /v1/parse is not allowed", async () => {
    const { app } = setup();
    expect((await app.request("/v1/parse", { headers: { Origin: ORIGIN } })).status).toBe(404);
  });
});
