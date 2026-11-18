import { describe, expect, it } from "vitest";
import { EmailPayloadSchema, ParseRequestSchema, ParsedOrderSchema } from "./order-schema.ts";

const validOrder = {
  isOrderConfirmation: true,
  retailer: "Mytheresa",
  orderNumber: "12345",
  orderDate: "2026-10-02",
  currency: "EUR",
  total: 1290,
  items: [
    {
      name: "Andiamo leather tote",
      brand: "Bottega Veneta",
      colour: "Black",
      size: "One size",
      quantity: 1,
      price: 1290,
      currency: "EUR",
      imageUrl: "https://img.mytheresa.com/p.jpg",
    },
  ],
};

describe("ParsedOrderSchema", () => {
  it("accepts a well-formed order", () => {
    expect(ParsedOrderSchema.parse(validOrder)).toEqual(validOrder);
  });

  it("accepts a non-order with no items", () => {
    const r = ParsedOrderSchema.safeParse({
      isOrderConfirmation: false,
      retailer: null,
      orderNumber: null,
      orderDate: null,
      currency: null,
      total: null,
      items: [],
    });
    expect(r.success).toBe(true);
  });

  it.each([
    ["negative price", { price: -1 }],
    ["lowercase currency", { currency: "eur" }],
    ["javascript: image URL", { imageUrl: "javascript:alert(1)" }],
    ["data: image URL", { imageUrl: "data:image/png;base64,AAAA" }],
    ["zero quantity", { quantity: 0 }],
    ["empty name", { name: "  " }],
    ["empty-string colour", { colour: "" }],
  ])("rejects an item with %s", (_label, patch) => {
    const bad = { ...validOrder, items: [{ ...validOrder.items[0], ...patch }] };
    expect(ParsedOrderSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-ISO order date", () => {
    expect(ParsedOrderSchema.safeParse({ ...validOrder, orderDate: "02/10/2026" }).success).toBe(
      false,
    );
  });
});

describe("EmailPayloadSchema", () => {
  const base = { messageId: "m1", from: "a@b.c", subject: "s", date: null };

  it("requires an html or text body", () => {
    expect(EmailPayloadSchema.safeParse({ ...base, html: null, text: null }).success).toBe(false);
    expect(EmailPayloadSchema.safeParse({ ...base, html: "  ", text: "" }).success).toBe(false);
  });

  it("accepts text-only and html-only bodies", () => {
    expect(EmailPayloadSchema.safeParse({ ...base, html: null, text: "hi" }).success).toBe(true);
    expect(EmailPayloadSchema.safeParse({ ...base, html: "<p>hi</p>", text: null }).success).toBe(
      true,
    );
  });

  it("rejects an empty message id", () => {
    expect(
      EmailPayloadSchema.safeParse({ ...base, messageId: "", html: "x", text: null }).success,
    ).toBe(false);
  });
});

describe("ParseRequestSchema", () => {
  const email = {
    messageId: "m1",
    from: "a@b.c",
    subject: "s",
    date: null,
    html: "<p>x</p>",
    text: null,
  };

  it("lowercases the account and defaults force to false", () => {
    const r = ParseRequestSchema.parse({ account: "Me@Gmail.com", source: "auto", email });
    expect(r.account).toBe("me@gmail.com");
    expect(r.force).toBe(false);
  });

  it.each([
    ["missing account", { source: "manual", email }],
    ["invalid account", { account: "not-an-email", source: "manual", email }],
    ["unknown source", { account: "me@gmail.com", source: "cron", email }],
  ])("rejects %s", (_label, body) => {
    expect(ParseRequestSchema.safeParse(body).success).toBe(false);
  });
});
