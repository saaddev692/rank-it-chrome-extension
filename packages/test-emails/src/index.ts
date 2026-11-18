import { readFileSync } from "node:fs";
import type { EmailPayload, ParsedOrder } from "@oep/shared";
import { round2, total } from "./format.ts";
import { mytheresa } from "./templates/mytheresa.ts";
import { revolve } from "./templates/revolve.ts";
import { selfridges } from "./templates/selfridges.ts";
import type { OrderData, RenderedEmail, Template } from "./types.ts";

export type { OrderData, OrderItemData, RenderedEmail } from "./types.ts";

export const TEMPLATES = { mytheresa, selfridges, revolve } satisfies Record<string, Template>;
export type TemplateName = keyof typeof TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[];

export { TEST_SUBJECT_TAG } from "@oep/shared";

export function isTemplateName(name: string): name is TemplateName {
  return Object.hasOwn(TEMPLATES, name);
}

export function loadOrder(name: TemplateName): OrderData {
  return JSON.parse(
    readFileSync(new URL(`../orders/${name}.json`, import.meta.url), "utf8"),
  ) as OrderData;
}

export function renderEmail(name: TemplateName, order: OrderData): RenderedEmail {
  return TEMPLATES[name].render(order);
}

/** The JSON the parser should return for this order. Derived from the data, not hand-written. */
export function expectedOrder(order: OrderData): ParsedOrder {
  return {
    isOrderConfirmation: true,
    retailer: order.retailer,
    orderNumber: order.orderNumber,
    orderDate: order.orderDate,
    currency: order.currency,
    total: total(order),
    items: order.items.map((item) => ({
      name: item.name,
      brand: item.brand,
      colour: item.colour,
      size: item.size,
      quantity: item.quantity,
      price: round2(item.price),
      currency: order.currency,
      imageUrl: item.imageUrl,
    })),
  };
}

/**
 * A fixture as it would arrive from the real retailer (real sender domain, stable IDs).
 * Used by the unit tests and `pnpm eval:live`.
 */
export function fixture(name: TemplateName): { email: EmailPayload; expected: ParsedOrder } {
  const order = loadOrder(name);
  const rendered = renderEmail(name, order);
  return {
    email: {
      messageId: `fixture-${name}`,
      from: `${rendered.fromName} <${rendered.retailerAddress}>`,
      subject: rendered.subject,
      date: new Date(`${order.orderDate}T09:00:00Z`).toUTCString(),
      html: rendered.html,
      text: rendered.text,
    },
    expected: expectedOrder(order),
  };
}

/** A copy of the order with a fresh order number and today's date, so every sent email is unique. */
export function freshOrder(
  name: TemplateName,
  order: OrderData,
  now: Date = new Date(),
  random: () => number = Math.random,
): OrderData {
  return {
    ...order,
    orderNumber: TEMPLATES[name].newOrderNumber(random),
    orderDate: now.toISOString().slice(0, 10),
  };
}
