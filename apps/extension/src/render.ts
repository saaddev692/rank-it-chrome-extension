import type { OrderItem, OrderRecord } from "@oep/shared";
import type { WatchState } from "./watch-state.ts";
import { MAX_ATTEMPTS } from "./watcher.ts";

// Everything here comes from emails, which are untrusted: build nodes with textContent only.

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

export function formatPrice(amount: number | null, currency: string | null): string {
  if (amount === null) return "Price unknown";
  if (!currency) return amount.toFixed(2);
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function itemCard(item: OrderItem): HTMLElement {
  const card = el("article", "item");
  if (item.imageUrl && item.imageUrl.startsWith("https://")) {
    const img = el("img");
    img.src = item.imageUrl;
    img.alt = [item.brand, item.name].filter(Boolean).join(" ");
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    card.append(img);
  } else {
    card.append(el("div", "noimg", "No product image"));
  }
  const body = el("div", "body");
  if (item.brand) body.append(el("div", "brand", item.brand));
  body.append(el("div", "name", item.name));
  const attrs = [
    item.colour && `Colour: ${item.colour}`,
    item.size && `Size: ${item.size}`,
    item.quantity > 1 && `Qty: ${item.quantity}`,
  ].filter(Boolean);
  if (attrs.length > 0) body.append(el("div", "attrs", attrs.join(" · ")));
  body.append(el("div", "price", formatPrice(item.price, item.currency)));
  card.append(body);
  return card;
}

/** One history entry: summary, product cards and the stored record JSON exactly as returned. */
export function recordCard(
  record: OrderRecord,
  onReparse: (messageId: string) => void,
): HTMLElement {
  const { order } = record;
  const card = el("article", "record");
  card.dataset["messageId"] = record.messageId;

  const head = el("div", "record-head");
  const title = el(
    "div",
    "record-title",
    order.isOrderConfirmation
      ? [order.retailer ?? "Unknown retailer", order.orderNumber && `#${order.orderNumber}`]
          .filter(Boolean)
          .join(" ")
      : "Not an order confirmation",
  );
  title.append(el("span", `badge ${record.source}`, record.source === "auto" ? "auto" : "manual"));
  head.append(
    title,
    button("Re-parse", "ghost small", () => onReparse(record.messageId)),
  );

  const meta = el(
    "div",
    "meta",
    [record.subject, `parsed ${formatTimestamp(record.parsedAt)}`, record.model].join(" · "),
  );

  card.append(head, meta);

  if (order.isOrderConfirmation) {
    const summary = el("dl", "summary");
    const fields: [string, string][] = [
      ["Order date", order.orderDate ?? "Unknown"],
      ["Total", formatPrice(order.total, order.currency)],
      ["Items", String(order.items.length)],
    ];
    for (const [label, value] of fields) {
      const wrap = el("div");
      wrap.append(el("dt", undefined, label), el("dd", undefined, value));
      summary.append(wrap);
    }
    const items = el("div", "items");
    for (const item of order.items) items.append(itemCard(item));
    card.append(summary, items);
  }

  const details = el("details");
  details.append(
    el("summary", undefined, "JSON"),
    el("pre", "json", JSON.stringify(record, null, 2)),
  );
  card.append(details);
  return card;
}

export function renderHistory(
  container: HTMLElement,
  records: OrderRecord[],
  onReparse: (messageId: string) => void,
): void {
  container.replaceChildren();
  if (records.length === 0) {
    container.append(
      el("p", "empty", "No parsed emails yet. Click Search Gmail, or turn on auto-check."),
    );
    return;
  }
  for (const record of records) container.append(recordCard(record, onReparse));
}

/** Auto-check status line. The pending list is described as a queue so it's clear nothing is lost. */
export function describeWatchStatus(state: WatchState): { text: string; isError: boolean } {
  if (!state.enabled) return { text: "Auto-check is off.", isError: false };
  const queued = state.pending.length;
  const parts = [
    state.lastCheckedAt
      ? `Last checked ${formatTimestamp(state.lastCheckedAt)}`
      : "Waiting for first check",
    queued > 0
      ? `${queued} email${queued === 1 ? "" : "s"} in the queue, not parsed yet. Next attempt within a minute (each email is tried up to ${MAX_ATTEMPTS} times)`
      : null,
    state.lastError ? `${queued > 0 ? "Reason" : "Last error"}: ${state.lastError}` : null,
  ];
  return { text: parts.filter(Boolean).join(" · "), isError: Boolean(state.lastError) };
}
