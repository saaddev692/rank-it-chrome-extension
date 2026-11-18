import type { OrderRecord } from "@oep/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WATCH_STATE } from "./watch-state.ts";
import {
  describeWatchStatus,
  formatPrice,
  formatTimestamp,
  recordCard,
  renderHistory,
} from "./render.ts";

const XSS = `<img src=x onerror="window.xssFired=true">`;

const record: OrderRecord = {
  account: "me@gmail.com",
  messageId: "m1",
  from: "REVOLVE <orders@email.revolve.com>",
  subject: "Your REVOLVE order #RV7781234 is confirmed",
  emailDate: "Tue, 27 Oct 2026 21:03:55 -0700",
  source: "auto",
  model: "gemini-3.8-flash",
  parsedAt: "2026-11-18T10:00:00.000Z",
  order: {
    isOrderConfirmation: true,
    retailer: "Revolve",
    orderNumber: "RV7781234",
    orderDate: "2026-10-27",
    currency: "USD",
    total: 317.11,
    items: [
      {
        name: "Rosalind Mini Dress",
        brand: "Lovers and Friends",
        colour: "Black",
        size: "S",
        quantity: 1,
        price: 228,
        currency: "USD",
        imageUrl: "https://placehold.co/420x560/png?text=Rosalind",
      },
      {
        name: XSS,
        brand: null,
        colour: null,
        size: null,
        quantity: 2,
        price: null,
        currency: null,
        imageUrl: "http://insecure.example/p.jpg",
      },
    ],
  },
};

const notOrder: OrderRecord = {
  ...record,
  messageId: "m2",
  source: "manual",
  order: {
    isOrderConfirmation: false,
    retailer: null,
    orderNumber: null,
    orderDate: null,
    currency: null,
    total: null,
    items: [],
  },
};

beforeEach(() => document.body.replaceChildren());

describe("formatPrice", () => {
  it("formats known currencies", () => {
    expect(formatPrice(3900, "EUR")).toBe("€3,900.00");
    expect(formatPrice(1250, "GBP")).toBe("£1,250.00");
    expect(formatPrice(61.6, "USD")).toBe("US$61.60");
  });

  it("handles missing amount, missing currency and invalid codes", () => {
    expect(formatPrice(null, "EUR")).toBe("Price unknown");
    expect(formatPrice(10, null)).toBe("10.00");
    expect(formatPrice(10, "ZZ")).toBe("10.00 ZZ");
  });
});

describe("formatTimestamp", () => {
  it("formats ISO timestamps and passes through garbage", () => {
    expect(formatTimestamp("2026-11-18T10:00:00.000Z")).toMatch(/18 Nov 2026/);
    expect(formatTimestamp("not a date")).toBe("not a date");
  });
});

describe("recordCard", () => {
  it("shows the summary, one card per item and the source badge", () => {
    const card = recordCard(record, () => {});
    expect(card.dataset["messageId"]).toBe("m1");
    expect(card.querySelector(".record-title")?.textContent).toContain("Revolve #RV7781234");
    expect(card.querySelector(".badge.auto")?.textContent).toBe("auto");
    expect(card.querySelectorAll(".item")).toHaveLength(2);
    expect(card.textContent).toContain("Colour: Black · Size: S");
    expect(card.textContent).toContain("Qty: 2");
    expect(card.textContent).toContain("US$317.11");
  });

  it("shows the stored record JSON exactly as returned", () => {
    const pre = recordCard(record, () => {}).querySelector("details pre");
    expect(pre?.textContent).toBe(JSON.stringify(record, null, 2));
  });

  it("calls onReparse with the message id", () => {
    const onReparse = vi.fn<(id: string) => void>();
    recordCard(record, onReparse).querySelector<HTMLButtonElement>(".record-head button")!.click();
    expect(onReparse).toHaveBeenCalledWith("m1");
  });

  it("loads only https images, with no-referrer", () => {
    const card = recordCard(record, () => {});
    const imgs = card.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute("src")).toBe(record.order.items[0]!.imageUrl);
    expect(imgs[0]!.referrerPolicy).toBe("no-referrer");
    expect(card.querySelectorAll(".noimg")).toHaveLength(1);
  });

  it("renders untrusted strings as text, never as HTML", () => {
    const card = recordCard({ ...record, subject: XSS }, () => {});
    document.body.append(card);
    expect(card.textContent).toContain(XSS);
    expect(card.querySelector("img[onerror]")).toBeNull();
    expect((window as unknown as Record<string, unknown>)["xssFired"]).toBeUndefined();
  });

  it("labels non-order emails and still shows their JSON", () => {
    const card = recordCard(notOrder, () => {});
    expect(card.querySelector(".record-title")?.textContent).toContain("Not an order confirmation");
    expect(card.querySelector(".items")).toBeNull();
    expect(card.querySelector("details pre")).not.toBeNull();
  });
});

describe("renderHistory", () => {
  it("renders records in the given order and replaces previous content", () => {
    const container = document.createElement("div");
    renderHistory(container, [record, notOrder], () => {});
    renderHistory(container, [record, notOrder], () => {});
    const ids = [...container.querySelectorAll<HTMLElement>(".record")].map(
      (r) => r.dataset["messageId"],
    );
    expect(ids).toEqual(["m1", "m2"]);
  });

  it("shows an empty state", () => {
    const container = document.createElement("div");
    renderHistory(container, [], () => {});
    expect(container.textContent).toContain("No parsed emails yet");
  });
});

describe("describeWatchStatus", () => {
  const on = { ...DEFAULT_WATCH_STATE, enabled: true, lastCheckedAt: "2026-11-18T10:00:00.000Z" };

  it("says when auto-check is off", () => {
    expect(describeWatchStatus(DEFAULT_WATCH_STATE)).toEqual({
      text: "Auto-check is off.",
      isError: false,
    });
  });

  it("shows the last check when everything is fine", () => {
    const { text, isError } = describeWatchStatus(on);
    expect(text).toMatch(/^Last checked 18 Nov 2026/);
    expect(text).not.toContain("queue");
    expect(isError).toBe(false);
  });

  it("describes pending emails as a queue with what happens next and why", () => {
    const { text, isError } = describeWatchStatus({
      ...on,
      pending: [
        { id: "a", attempts: 1 },
        { id: "b", attempts: 1 },
        { id: "c", attempts: 2 },
      ],
      lastError: "Cannot reach the parsing proxy",
    });
    expect(text).toContain(
      "3 emails in the queue, not parsed yet. Next attempt within a minute (each email is tried up to 5 times)",
    );
    expect(text).toContain("Reason: Cannot reach the parsing proxy");
    expect(text).not.toContain("retry");
    expect(isError).toBe(true);
  });

  it("uses the singular for one queued email", () => {
    const { text } = describeWatchStatus({ ...on, pending: [{ id: "a", attempts: 1 }] });
    expect(text).toContain("1 email in the queue");
  });

  it("labels an error without a queue as the last error", () => {
    const { text } = describeWatchStatus({ ...on, lastError: "Auto-check paused: sign in again" });
    expect(text).toContain("Last error: Auto-check paused: sign in again");
  });

  it("before the first check", () => {
    expect(describeWatchStatus({ ...on, lastCheckedAt: null }).text).toBe(
      "Waiting for first check",
    );
  });
});
