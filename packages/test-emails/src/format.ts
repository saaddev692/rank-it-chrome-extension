import type { OrderData } from "./types.ts";

export function subtotal(order: OrderData): number {
  return round2(order.items.reduce((sum, item) => sum + item.price * item.quantity, 0));
}

export function total(order: OrderData): number {
  return round2(subtotal(order) + order.shipping + order.tax);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 3900 -> "3,900"; 61.6 -> "61.60". Whole amounts drop the decimals (Mytheresa style). */
export function compactAmount(n: number): string {
  return Number.isInteger(n)
    ? n.toLocaleString("en-US")
    : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 1250 -> "1,250.00" */
export function fullAmount(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parts(isoDate: string): { y: number; m: number; d: number } {
  const [y, m, d] = isoDate.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** 2026-10-02 -> "02.10.2026" (German/EU) */
export function dateDotted(iso: string): string {
  const { y, m, d } = parts(iso);
  return `${pad(d)}.${pad(m)}.${y}`;
}

/** 2026-09-14 -> "14 September 2026" (UK) */
export function dateLong(iso: string): string {
  const { y, m, d } = parts(iso);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** 2026-10-27 -> "10/27/2026" (US) */
export function dateUs(iso: string): string {
  const { y, m, d } = parts(iso);
  return `${pad(m)}/${pad(d)}/${y}`;
}

export function titleToUpper(s: string): string {
  return s.toUpperCase();
}

export function digits(random: () => number, count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) out += Math.floor(random() * 10).toString();
  return out;
}
