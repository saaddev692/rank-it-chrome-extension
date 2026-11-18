import type { RetailerName } from "@oep/shared";

/**
 * The single source of truth for a mock order. Templates decide how it looks (uppercase brands,
 * "€ 3,900" vs "£1,250.00", date formats); the expected parser output is derived from the same
 * data, so changing an order means editing one JSON file.
 */
export interface OrderData {
  retailer: RetailerName;
  orderNumber: string;
  /** YYYY-MM-DD */
  orderDate: string;
  currency: "EUR" | "GBP" | "USD";
  customerName: string;
  shipping: number;
  /** Tax added on top of item prices (0 when prices include VAT). */
  tax: number;
  items: OrderItemData[];
}

export interface OrderItemData {
  brand: string;
  name: string;
  colour: string;
  size: string;
  quantity: number;
  /** Unit price actually charged. */
  price: number;
  /** Shown crossed out next to `price` when the item was on sale. */
  originalPrice?: number;
  imageUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** Display name for the From header. */
  fromName: string;
  /** The retailer's real sender address, used for offline fixtures (not for sending). */
  retailerAddress: string;
}

export interface Template {
  render(order: OrderData): RenderedEmail;
  newOrderNumber(random: () => number): string;
}
