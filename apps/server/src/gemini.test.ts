import { describe, expect, it, vi } from "vitest";
import { AppError } from "./errors.ts";
import { createGeminiExtractor, outputText } from "./gemini.ts";
import { interactionResponse } from "./test-helpers.ts";

function extractorWith(fetchImpl: typeof fetch, timeoutMs = 5000) {
  return createGeminiExtractor({
    apiKey: "test-key",
    model: "gemini-test-flash",
    apiRevision: "2026-05-20",
    timeoutMs,
    fetch: fetchImpl,
  });
}

async function expectAppError(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  expect((err as AppError).status).toBe(status);
  return err as AppError;
}

describe("createGeminiExtractor", () => {
  it("sends a structured-output Interactions request and returns parsed JSON", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      interactionResponse('{"isOrderConfirmation":true}'),
    );
    const result = await extractorWith(fetchMock).extract("EMAIL TEXT");

    expect(result).toEqual({ isOrderConfirmation: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("test-key");
    expect(headers["Api-Revision"]).toBe("2026-05-20");
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gemini-test-flash",
      input: "EMAIL TEXT",
      store: false,
      response_format: { type: "text", mime_type: "application/json" },
    });
    expect(body["system_instruction"]).toContain("untrusted");
  });

  it("never puts the API key in the URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => interactionResponse("{}"));
    await extractorWith(fetchMock).extract("x");
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("test-key");
  });

  it("maps HTTP 429 to upstream_rate_limited", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { message: "Quota exceeded" } }, { status: 429 }),
    );
    const err = await expectAppError(extractorWith(f).extract("x"), "upstream_rate_limited", 429);
    expect(err.message).toContain("Quota exceeded");
  });

  it.each([400, 401, 403, 500, 503])("maps HTTP %i to upstream_error", async (status) => {
    const f = vi.fn<typeof fetch>(
      async () => new Response("<html>oops</html>", { status, statusText: "Bad" }),
    );
    await expectAppError(extractorWith(f).extract("x"), "upstream_error", 502);
  });

  it("reads the message from array-wrapped Google errors (invalid API key)", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      Response.json(
        [
          {
            error: {
              code: 400,
              message: "API key not valid. Please pass a valid API key.",
              status: "INVALID_ARGUMENT",
            },
          },
        ],
        { status: 400 },
      ),
    );
    const err = await expectAppError(extractorWith(f).extract("x"), "upstream_error", 502);
    expect(err.message).toContain("API key not valid");
  });

  it("truncates long upstream error messages", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { message: "x".repeat(5000) } }, { status: 400 }),
    );
    const err = await expectAppError(extractorWith(f).extract("x"), "upstream_error", 502);
    expect(err.message.length).toBeLessThan(400);
  });

  it("maps network failures to upstream_error", async () => {
    const f = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    await expectAppError(extractorWith(f).extract("x"), "upstream_error", 502);
  });

  it("times out slow responses", async () => {
    const f = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    await expectAppError(extractorWith(f, 1000).extract("x"), "upstream_timeout", 504);
  });

  it("rejects a non-JSON 200 body", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response("not json", { status: 200 }));
    await expectAppError(extractorWith(f).extract("x"), "upstream_error", 502);
  });

  it("reports failed interactions with their error messages", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      Response.json({
        status: "failed",
        steps: [],
        errors: [{ code: "safety", message: "Blocked by safety filters" }],
      }),
    );
    const err = await expectAppError(extractorWith(f).extract("x"), "upstream_error", 502);
    expect(err.message).toContain("Blocked by safety filters");
  });

  it.each(["incomplete", "requires_continuation", undefined])(
    "rejects status %s",
    async (status) => {
      const f = vi.fn<typeof fetch>(async () => Response.json({ status, steps: [] }));
      await expectAppError(extractorWith(f).extract("x"), "invalid_model_output", 502);
    },
  );

  it("rejects a completed interaction with no text output", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      Response.json({ status: "completed", steps: [{ type: "thought" }] }),
    );
    await expectAppError(extractorWith(f).extract("x"), "invalid_model_output", 502);
  });

  it("rejects output that is not JSON", async () => {
    const f = vi.fn<typeof fetch>(async () => interactionResponse("Sure! Here is the order: {"));
    await expectAppError(extractorWith(f).extract("x"), "invalid_model_output", 502);
  });
});

describe("outputText", () => {
  it("joins consecutive text blocks of the last model_output step", () => {
    expect(
      outputText({
        steps: [
          { type: "model_output", content: [{ type: "text", text: "old" }] },
          {
            type: "model_output",
            content: [
              { type: "text", text: '{"a":' },
              { type: "text", text: "1}" },
            ],
          },
        ],
      }),
    ).toBe('{"a":1}');
  });

  it("ignores non-text content and returns null when empty", () => {
    expect(
      outputText({ steps: [{ type: "model_output", content: [{ type: "image" }] }] }),
    ).toBeNull();
    expect(outputText({})).toBeNull();
  });
});
