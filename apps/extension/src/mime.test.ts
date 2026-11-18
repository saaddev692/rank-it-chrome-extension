import { describe, expect, it } from "vitest";
import {
  type GmailMessagePart,
  base64UrlToBytes,
  decodePartData,
  findBodyParts,
  header,
} from "./mime.ts";
import { b64url } from "./test-helpers.ts";

describe("base64UrlToBytes", () => {
  it.each(["", "a", "ab", "abc", "€ 3,900 — ünïcödé", "x".repeat(1000)])("round-trips %j", (s) => {
    expect(new TextDecoder().decode(base64UrlToBytes(b64url(s)))).toBe(s);
  });

  it("handles - and _ characters and embedded whitespace", () => {
    const encoded = b64url("??>>??>>");
    expect(encoded).toMatch(/[-_]/);
    expect(
      new TextDecoder().decode(base64UrlToBytes(`${encoded.slice(0, 4)}\n${encoded.slice(4)}`)),
    ).toBe("??>>??>>");
  });

  it("throws on invalid input", () => {
    expect(() => base64UrlToBytes("!!!!")).toThrow(/invalid character/i);
  });
});

describe("header", () => {
  it("matches names case-insensitively and returns null when absent", () => {
    const part: GmailMessagePart = { headers: [{ name: "SUBJECT", value: "Hi" }] };
    expect(header(part, "Subject")).toBe("Hi");
    expect(header(part, "From")).toBeNull();
    expect(header({}, "From")).toBeNull();
  });
});

describe("decodePartData", () => {
  it("defaults to UTF-8", () => {
    expect(decodePartData({}, b64url("£1,250.00"))).toBe("£1,250.00");
  });

  it("honours a declared ISO-8859-1 charset", () => {
    const part: GmailMessagePart = {
      headers: [{ name: "Content-Type", value: 'text/html; charset="ISO-8859-1"' }],
    };
    expect(decodePartData(part, b64url("£ café", "latin1"))).toBe("£ café");
  });

  it("falls back to UTF-8 for an unknown charset label", () => {
    const part: GmailMessagePart = {
      headers: [{ name: "Content-Type", value: "text/plain; charset=x-made-up" }],
    };
    expect(decodePartData(part, b64url("ok €"))).toBe("ok €");
  });
});

describe("findBodyParts", () => {
  const html: GmailMessagePart = { mimeType: "text/html", body: { data: "h" } };
  const text: GmailMessagePart = { mimeType: "text/plain", body: { data: "t" } };

  it("handles a single-part HTML message", () => {
    expect(findBodyParts(html)).toEqual({ html, text: null });
  });

  it("finds both alternatives inside multipart/mixed > multipart/related > multipart/alternative", () => {
    const root: GmailMessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/related",
          parts: [
            { mimeType: "multipart/alternative", parts: [text, html] },
            { mimeType: "image/png", filename: "logo.png", body: { attachmentId: "img" } },
          ],
        },
        { mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "pdf" } },
      ],
    };
    expect(findBodyParts(root)).toEqual({ html, text });
  });

  it("skips HTML attachments (filename or Content-Disposition: attachment)", () => {
    const root: GmailMessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/html", filename: "receipt.html", body: { attachmentId: "a" } },
        {
          mimeType: "text/html",
          headers: [{ name: "Content-Disposition", value: "attachment" }],
          body: { data: "x" },
        },
        text,
      ],
    };
    expect(findBodyParts(root)).toEqual({ html: null, text });
  });

  it("returns the first of duplicate parts", () => {
    const second: GmailMessagePart = { mimeType: "text/html", body: { data: "second" } };
    expect(findBodyParts({ mimeType: "multipart/alternative", parts: [html, second] }).html).toBe(
      html,
    );
  });

  it("handles empty and malformed structures", () => {
    expect(findBodyParts({})).toEqual({ html: null, text: null });
    expect(findBodyParts({ mimeType: "multipart/alternative" })).toEqual({
      html: null,
      text: null,
    });
    expect(findBodyParts({ mimeType: "TEXT/HTML", body: {} }).html).not.toBeNull();
  });
});
