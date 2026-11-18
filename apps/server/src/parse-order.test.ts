import { ParsedOrderSchema } from "@oep/shared";
import { describe, expect, it } from "vitest";
import { AppError } from "./errors.ts";
import { parseOrderEmail } from "./parse-order.ts";
import { RESPONSE_JSON_SCHEMA } from "./prompt.ts";
import { FIXTURE_NAMES, fakeExtractor, loadFixture } from "./test-helpers.ts";

describe("parseOrderEmail", () => {
  it.each(FIXTURE_NAMES)(
    "%s: returns the model's order when it is valid and grounded",
    async (name) => {
      const { email, expected } = loadFixture(name);
      const { extractor, calls } = fakeExtractor(expected);

      await expect(parseOrderEmail(email, extractor)).resolves.toEqual(expected);
      expect(calls[0]).toContain(`From: ${email.from}`);
      expect(calls[0]).toContain(`Retailer detected from sender domain: ${expected.retailer}`);
      expect(calls[0]).toContain("<<<EMAIL_BODY");
    },
  );

  it("nulls image URLs the model invented (not present in the email)", async () => {
    const { email, expected } = loadFixture("revolve");
    const hallucinated = structuredClone(expected);
    hallucinated.items[0]!.imageUrl = "https://is4.revolveassets.com/images/p4/n/tv/MADE-UP_V1.jpg";
    const { extractor } = fakeExtractor(hallucinated);

    const order = await parseOrderEmail(email, extractor);
    expect(order.items[0]!.imageUrl).toBeNull();
    expect(order.items[1]!.imageUrl).toBe(expected.items[1]!.imageUrl);
  });

  it("nulls a tracking-pixel URL even though it appears in the raw HTML", async () => {
    const { email, expected } = loadFixture("mytheresa");
    const bad = structuredClone(expected);
    bad.items[0]!.imageUrl = "https://click.e.mytheresa.com/open.aspx?ffcb10-fe8a1677-abc";
    const { extractor } = fakeExtractor(bad);
    expect((await parseOrderEmail(email, extractor)).items[0]!.imageUrl).toBeNull();
  });

  it("overrides the retailer with the one implied by the sender domain", async () => {
    const { email, expected } = loadFixture("selfridges");
    const { extractor } = fakeExtractor({ ...expected, retailer: "Harrods" });
    expect((await parseOrderEmail(email, extractor)).retailer).toBe("Selfridges");
  });

  it("keeps the model's retailer for unknown sender domains", async () => {
    const { email, expected } = loadFixture("selfridges");
    const { extractor } = fakeExtractor({ ...expected, retailer: "Some Store" });
    const order = await parseOrderEmail({ ...email, from: "shop@unknown.example" }, extractor);
    expect(order.retailer).toBe("Some Store");
  });

  it("normalises lowercase currencies and empty strings", async () => {
    const { email, expected } = loadFixture("mytheresa");
    const messy = structuredClone(expected) as unknown as Record<string, unknown> & {
      items: Record<string, unknown>[];
    };
    messy["currency"] = "eur";
    messy.items[0]!["currency"] = " eur ";
    messy.items[0]!["colour"] = "";
    messy["orderNumber"] = "   ";
    const { extractor } = fakeExtractor(messy);

    const order = await parseOrderEmail(email, extractor);
    expect(order.currency).toBe("EUR");
    expect(order.items[0]!.currency).toBe("EUR");
    expect(order.items[0]!.colour).toBeNull();
    expect(order.orderNumber).toBeNull();
  });

  it("passes through non-order emails", async () => {
    const { email } = loadFixture("revolve");
    const notOrder = {
      isOrderConfirmation: false,
      retailer: null,
      orderNumber: null,
      orderDate: null,
      currency: null,
      total: null,
      items: [],
    };
    const { extractor } = fakeExtractor(notOrder);
    await expect(parseOrderEmail(email, extractor)).resolves.toEqual({
      ...notOrder,
      retailer: "Revolve",
    });
  });

  it.each([
    ["null output", null],
    ["an array", []],
    ["missing items", { isOrderConfirmation: true }],
    [
      "a string price",
      {
        ...loadFixture("revolve").expected,
        items: [{ ...loadFixture("revolve").expected.items[0], price: "$228" }],
      },
    ],
    ["items as a string", { ...loadFixture("revolve").expected, items: "none" }],
  ])("rejects invalid model output: %s", async (_label, output) => {
    const { email } = loadFixture("revolve");
    const { extractor } = fakeExtractor(output);
    const err = await parseOrderEmail(email, extractor).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("invalid_model_output");
  });

  it("propagates extractor errors", async () => {
    const { email } = loadFixture("revolve");
    const { extractor } = fakeExtractor(() => {
      throw new AppError("upstream_timeout", 504, "slow");
    });
    await expect(parseOrderEmail(email, extractor)).rejects.toMatchObject({
      code: "upstream_timeout",
    });
  });
});

describe("RESPONSE_JSON_SCHEMA", () => {
  it("lists exactly the fields of ParsedOrderSchema", () => {
    expect(Object.keys(RESPONSE_JSON_SCHEMA.properties).toSorted()).toEqual(
      Object.keys(ParsedOrderSchema.shape).toSorted(),
    );
    expect([...RESPONSE_JSON_SCHEMA.required].toSorted()).toEqual(
      Object.keys(ParsedOrderSchema.shape).toSorted(),
    );
    const itemShape = ParsedOrderSchema.shape.items.element.shape;
    expect(Object.keys(RESPONSE_JSON_SCHEMA.properties.items.items.properties).toSorted()).toEqual(
      Object.keys(itemShape).toSorted(),
    );
    expect([...RESPONSE_JSON_SCHEMA.properties.items.items.required].toSorted()).toEqual(
      Object.keys(itemShape).toSorted(),
    );
  });
});
