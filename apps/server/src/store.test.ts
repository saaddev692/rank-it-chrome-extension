import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OrderRecord } from "@oep/shared";
import { describe, expect, it } from "vitest";
import { openOrderStore } from "./store.ts";
import { loadFixture } from "./test-helpers.ts";

const { expected } = loadFixture("mytheresa");

function record(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    account: "me@gmail.com",
    messageId: "m1",
    from: "MYTHERESA <noreply@mytheresa.com>",
    subject: "Your order confirmation",
    emailDate: "Fri, 02 Oct 2026 09:00:00 GMT",
    source: "manual",
    model: "test-model",
    parsedAt: "2026-11-18T10:00:00.000Z",
    order: expected,
    ...overrides,
  };
}

describe("openOrderStore", () => {
  it("returns null on a miss and the full record on a hit", () => {
    const store = openOrderStore(":memory:");
    expect(store.get("me@gmail.com", "m1")).toBeNull();
    store.upsert(record());
    expect(store.get("me@gmail.com", "m1")).toEqual(record());
    store.close();
  });

  it("keeps history separate per account", () => {
    const store = openOrderStore(":memory:");
    store.upsert(record({ account: "a@gmail.com" }));
    store.upsert(record({ account: "b@gmail.com", messageId: "m2" }));
    expect(store.get("b@gmail.com", "m1")).toBeNull();
    expect(store.list("a@gmail.com").map((r) => r.messageId)).toEqual(["m1"]);
    expect(store.list("b@gmail.com").map((r) => r.messageId)).toEqual(["m2"]);
    expect(store.list("nobody@gmail.com")).toEqual([]);
    store.close();
  });

  it("upsert replaces an existing record (re-parse)", () => {
    const store = openOrderStore(":memory:");
    store.upsert(record());
    store.upsert(record({ source: "auto", order: { ...expected, total: 1 } }));
    const r = store.get("me@gmail.com", "m1");
    expect(r?.source).toBe("auto");
    expect(r?.order.total).toBe(1);
    expect(store.list("me@gmail.com")).toHaveLength(1);
    store.close();
  });

  it("lists newest first and honours the limit", () => {
    const store = openOrderStore(":memory:");
    store.upsert(record({ messageId: "old", parsedAt: "2026-01-01T00:00:00.000Z" }));
    store.upsert(record({ messageId: "new", parsedAt: "2026-11-01T00:00:00.000Z" }));
    store.upsert(record({ messageId: "mid", parsedAt: "2026-06-01T00:00:00.000Z" }));
    expect(store.list("me@gmail.com").map((r) => r.messageId)).toEqual(["new", "mid", "old"]);
    expect(store.list("me@gmail.com", 1).map((r) => r.messageId)).toEqual(["new"]);
    store.close();
  });

  it("round-trips the order JSON exactly", () => {
    const store = openOrderStore(":memory:");
    const nonOrder = record({
      messageId: "news",
      order: {
        isOrderConfirmation: false,
        retailer: null,
        orderNumber: null,
        orderDate: null,
        currency: null,
        total: null,
        items: [],
      },
    });
    store.upsert(nonOrder);
    expect(store.get("me@gmail.com", "news")).toEqual(nonOrder);
    store.close();
  });

  it("persists to disk and creates parent directories", () => {
    const path = join(mkdtempSync(join(tmpdir(), "oep-store-")), "nested", "orders.db");
    const first = openOrderStore(path);
    first.upsert(record());
    first.close();
    const second = openOrderStore(path);
    expect(second.get("me@gmail.com", "m1")).toEqual(record());
    second.close();
  });

  it("does not store raw email bodies", () => {
    const path = join(mkdtempSync(join(tmpdir(), "oep-store-")), "orders.db");
    openOrderStore(path).close();
    const db = new DatabaseSync(path);
    const cols = db
      .prepare("SELECT name FROM pragma_table_info('orders')")
      .all()
      .map((r) => r["name"]);
    db.close();
    expect(cols).not.toContain("html");
    expect(cols).not.toContain("text");
  });

  it("skips and logs rows that are corrupt or no longer match the schema", () => {
    const path = join(mkdtempSync(join(tmpdir(), "oep-store-")), "orders.db");
    const store = openOrderStore(path);
    store.upsert(record({ messageId: "good" }));
    store.close();

    const db = new DatabaseSync(path);
    const insert = db.prepare(
      `INSERT INTO orders VALUES ('me@gmail.com', ?, 'f', 's', NULL, 'manual', 'm', 1, ?, '2026-11-18T00:00:00.000Z')`,
    );
    insert.run("corrupt", "{not json");
    insert.run("old-shape", JSON.stringify({ brand: "x" }));
    db.close();

    const logs: string[] = [];
    const reopened = openOrderStore(path, (m) => logs.push(m));
    expect(reopened.list("me@gmail.com").map((r) => r.messageId)).toEqual(["good"]);
    expect(reopened.get("me@gmail.com", "corrupt")).toBeNull();
    expect(logs.join("\n")).toContain("old-shape");
    reopened.close();
  });

  it("rejects an unknown source at the database level", () => {
    const store = openOrderStore(":memory:");
    expect(() => store.upsert(record({ source: "cron" as "auto" }))).toThrow(/CHECK constraint/);
    store.close();
  });
});
