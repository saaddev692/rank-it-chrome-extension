import { describe, expect, it } from "vitest";
import { isBackgroundRequest } from "./messages.ts";
import { DEFAULT_WATCH_STATE, WATCH_STATE_KEY, chromeWatchStateStore } from "./watch-state.ts";

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data = structuredClone(initial);
  return {
    data,
    area: {
      async get(key: string) {
        return key in data ? { [key]: structuredClone(data[key]) } : {};
      },
      async set(items: Record<string, unknown>) {
        Object.assign(data, structuredClone(items));
      },
    } as unknown as chrome.storage.StorageArea,
  };
}

describe("chromeWatchStateStore", () => {
  it("returns defaults when nothing is stored", async () => {
    const { area } = fakeStorage();
    const state = await chromeWatchStateStore(area).get();
    expect(state).toEqual(DEFAULT_WATCH_STATE);
    expect(state.enabled).toBe(false);
    expect(state).not.toHaveProperty("query");
  });

  it("merges stored values over defaults (older stored shapes keep working)", async () => {
    const { area } = fakeStorage({ [WATCH_STATE_KEY]: { enabled: true, historyId: "9" } });
    expect(await chromeWatchStateStore(area).get()).toEqual({
      ...DEFAULT_WATCH_STATE,
      enabled: true,
      historyId: "9",
    });
  });

  it("patch updates only the given fields and persists them", async () => {
    const storage = fakeStorage();
    const store = chromeWatchStateStore(storage.area);
    await store.patch({ enabled: true });
    const next = await store.patch({ historyId: "42" });
    expect(next).toMatchObject({ enabled: true, historyId: "42" });
    expect(storage.data[WATCH_STATE_KEY]).toMatchObject({ enabled: true, historyId: "42" });
  });

  it("never stores anything that looks like a token", async () => {
    const storage = fakeStorage();
    await chromeWatchStateStore(storage.area).patch({ enabled: true, account: "me@gmail.com" });
    expect(Object.keys(storage.data[WATCH_STATE_KEY] as object).toSorted()).toEqual(
      Object.keys(DEFAULT_WATCH_STATE).toSorted(),
    );
    expect(JSON.stringify(storage.data)).not.toMatch(/token/i);
  });
});

describe("isBackgroundRequest", () => {
  it.each([
    [{ type: "watch:configure", enabled: true, resetCursor: false }],
    [{ type: "watch:check-now" }],
    [{ type: "watch:seen" }],
  ])("accepts %j", (msg) => {
    expect(isBackgroundRequest(msg)).toBe(true);
  });

  it.each([
    [null],
    ["watch:seen"],
    [{ type: "unknown" }],
    [{ type: "watch:configure", enabled: "yes", resetCursor: false }],
    [{ type: "watch:configure", enabled: true }],
  ])("rejects %j", (msg) => {
    expect(isBackgroundRequest(msg)).toBe(false);
  });
});
