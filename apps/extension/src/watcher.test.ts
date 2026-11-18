import {
  type EmailPayload,
  ORDER_SEARCH_QUERY,
  type ParseRequest,
  type ParseResponse,
} from "@oep/shared";
import { describe, expect, it, vi } from "vitest";
import { ExtensionError } from "./errors.ts";
import { type GmailClient, HistoryExpiredError } from "./gmail.ts";
import { DEFAULT_WATCH_STATE, type WatchState, type WatchStateStore } from "./watch-state.ts";
import { MAX_ATTEMPTS, type WatcherDeps, checkForNewOrders } from "./watcher.ts";

const NOW = new Date("2026-11-18T10:00:00.000Z");
const ACCOUNT = "me@gmail.com";

function memoryState(initial: Partial<WatchState>): WatchStateStore & { current: WatchState } {
  const store = {
    current: { ...DEFAULT_WATCH_STATE, ...initial },
    async get() {
      return structuredClone(store.current);
    },
    async patch(update: Partial<WatchState>) {
      store.current = { ...store.current, ...update };
      return structuredClone(store.current);
    },
  };
  return store;
}

const email = (id: string): EmailPayload => ({
  messageId: id,
  from: "MYTHERESA <me@gmail.com>",
  subject: `Your order ${id} [TEST ORDER]`,
  date: null,
  html: "<p>order</p>",
  text: null,
});

function fakeGmail(opts: {
  historyId?: string;
  arrived?: string[] | Error;
  newHistoryId?: string;
  matching?: string[];
  emailError?: Record<string, Error>;
}) {
  const gmail = {
    profile: vi.fn<GmailClient["profile"]>(async () => ({
      emailAddress: "Me@Gmail.com",
      historyId: opts.historyId ?? "500",
    })),
    newInboxMessageIds: vi.fn<GmailClient["newInboxMessageIds"]>(async () => {
      if (opts.arrived instanceof Error) throw opts.arrived;
      return { messageIds: opts.arrived ?? [], historyId: opts.newHistoryId ?? "600" };
    }),
    searchIds: vi.fn<GmailClient["searchIds"]>(async () => opts.matching ?? []),
    searchMessages: vi.fn<GmailClient["searchMessages"]>(async () => []),
    getEmail: vi.fn<GmailClient["getEmail"]>(async (id) => {
      const err = opts.emailError?.[id];
      if (err) throw err;
      return email(id);
    }),
  } satisfies GmailClient;
  return gmail;
}

function parser(behaviour: (req: ParseRequest) => ParseResponse | Error = okParse) {
  return vi.fn<(req: ParseRequest) => Promise<ParseResponse>>(async (req) => {
    const r = behaviour(req);
    if (r instanceof Error) throw r;
    return r;
  });
}

function okParse(req: ParseRequest, cached = false, isOrder = true): ParseResponse {
  return {
    cached,
    record: {
      account: req.account,
      messageId: req.email.messageId,
      from: req.email.from,
      subject: req.email.subject,
      emailDate: null,
      source: req.source,
      model: "m",
      parsedAt: NOW.toISOString(),
      order: {
        isOrderConfirmation: isOrder,
        retailer: null,
        orderNumber: null,
        orderDate: null,
        currency: null,
        total: null,
        items: [],
      },
    },
  };
}

function deps(
  state: WatchStateStore,
  gmail: GmailClient,
  parse: WatcherDeps["parse"],
): WatcherDeps {
  return { state, withGmail: (fn) => fn(gmail), parse, now: () => NOW };
}

const watching = { enabled: true, account: ACCOUNT, historyId: "500" };

describe("checkForNewOrders", () => {
  it("does nothing when auto-check is off", async () => {
    const state = memoryState({ enabled: false });
    const gmail = fakeGmail({});
    await expect(checkForNewOrders(deps(state, gmail, parser()))).resolves.toEqual({
      status: "disabled",
    });
    expect(gmail.profile).not.toHaveBeenCalled();
  });

  it("first run records a baseline cursor and parses nothing", async () => {
    const state = memoryState({ enabled: true, pending: [{ id: "stale", attempts: 1 }] });
    const gmail = fakeGmail({ historyId: "777" });
    const parse = parser();
    await expect(checkForNewOrders(deps(state, gmail, parse))).resolves.toEqual({
      status: "baseline",
      account: ACCOUNT,
    });
    expect(state.current).toMatchObject({
      account: ACCOUNT,
      historyId: "777",
      pending: [],
      lastCheckedAt: NOW.toISOString(),
    });
    expect(gmail.newInboxMessageIds).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it("re-baselines when a different account signs in", async () => {
    const state = memoryState({ ...watching, account: "other@gmail.com" });
    const gmail = fakeGmail({ historyId: "900" });
    const result = await checkForNewOrders(deps(state, gmail, parser()));
    expect(result.status).toBe("baseline");
    expect(state.current.historyId).toBe("900");
    expect(state.current.account).toBe(ACCOUNT);
  });

  it("parses only newly arrived messages that match the query", async () => {
    const state = memoryState(watching);
    const gmail = fakeGmail({
      arrived: ["new-order", "new-newsletter"],
      matching: ["new-order", "old-order"],
    });
    const parse = parser();
    const result = await checkForNewOrders(deps(state, gmail, parse));

    expect(result).toEqual({
      status: "checked",
      account: ACCOUNT,
      newOrders: 1,
      pending: 0,
      failed: 0,
      ignored: 0,
    });
    expect(gmail.newInboxMessageIds).toHaveBeenCalledWith("500");
    expect(gmail.searchIds).toHaveBeenCalledWith(ORDER_SEARCH_QUERY, 100);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0]![0]).toEqual({
      account: ACCOUNT,
      source: "auto",
      email: email("new-order"),
    });
    expect(state.current).toMatchObject({
      historyId: "600",
      pending: [],
      lastError: null,
      lastCheckedAt: NOW.toISOString(),
      unseen: 1,
    });
  });

  it("ignores new mail that matched Gmail's query but fails the strict sender rule", async () => {
    const state = memoryState(watching);
    const gmail = fakeGmail({ arrived: ["gh", "ok"], matching: ["gh", "ok"] });
    gmail.getEmail.mockImplementation(async (id) =>
      id === "gh"
        ? { ...email(id), from: "GitHub <notifications@github.com>", subject: "Fix test order" }
        : { ...email(id), subject: "Your order [TEST ORDER]" },
    );
    const parse = parser();
    const result = await checkForNewOrders(deps(state, gmail, parse));
    expect(result).toMatchObject({ newOrders: 1, ignored: 1, pending: 0, failed: 0 });
    expect(parse.mock.calls.map((c) => c[0].email.messageId)).toEqual(["ok"]);
    expect(state.current.pending).toEqual([]);
  });

  it("skips the search entirely when nothing arrived", async () => {
    const state = memoryState(watching);
    const gmail = fakeGmail({ arrived: [] });
    const result = await checkForNewOrders(deps(state, gmail, parser()));
    expect(result).toMatchObject({ status: "checked", newOrders: 0 });
    expect(gmail.searchIds).not.toHaveBeenCalled();
    expect(state.current.historyId).toBe("600");
  });

  it("does not count history hits or non-orders as new orders", async () => {
    const state = memoryState({ ...watching, unseen: 2 });
    const gmail = fakeGmail({ arrived: ["a", "b"], matching: ["a", "b"] });
    const parse = parser((req) =>
      okParse(req, req.email.messageId === "a", req.email.messageId === "a"),
    );
    const result = await checkForNewOrders(deps(state, gmail, parse));
    expect(result).toMatchObject({ newOrders: 0 });
    expect(state.current.unseen).toBe(2);
  });

  it("keeps failed messages pending and retries them on the next check", async () => {
    const state = memoryState(watching);
    const gmail = fakeGmail({ arrived: ["a"], matching: ["a"] });
    let proxyUp = false;
    const parse = parser((req) =>
      proxyUp
        ? okParse(req)
        : new ExtensionError("proxy_unreachable", "Cannot reach the parsing proxy"),
    );

    const first = await checkForNewOrders(deps(state, gmail, parse));
    expect(first).toMatchObject({ newOrders: 0, pending: 1 });
    expect(state.current.pending).toEqual([{ id: "a", attempts: 1 }]);
    expect(state.current.lastError).toContain("Cannot reach the parsing proxy");

    proxyUp = true;
    const quiet = fakeGmail({ arrived: [], newHistoryId: "700" });
    const second = await checkForNewOrders(deps(state, quiet, parse));
    expect(second).toMatchObject({ newOrders: 1, pending: 0 });
    expect(state.current).toMatchObject({ pending: [], lastError: null, historyId: "700" });
  });

  it(`drops a message after ${MAX_ATTEMPTS} failed attempts`, async () => {
    const state = memoryState({ ...watching, pending: [{ id: "a", attempts: MAX_ATTEMPTS - 1 }] });
    const gmail = fakeGmail({ arrived: [] });
    const parse = parser(() => new ExtensionError("proxy_error", "Model output failed validation"));
    const result = await checkForNewOrders(deps(state, gmail, parse));
    expect(result).toMatchObject({ pending: 0, failed: 1 });
    expect(state.current.pending).toEqual([]);
  });

  it("drops oversized emails immediately instead of retrying", async () => {
    const state = memoryState(watching);
    const gmail = fakeGmail({ arrived: ["big"], matching: ["big"] });
    const parse = parser(() => new ExtensionError("email_too_large", "too big"));
    const result = await checkForNewOrders(deps(state, gmail, parse));
    expect(result).toMatchObject({ pending: 0, failed: 1 });
  });

  it("retries when fetching the email from Gmail fails", async () => {
    const state = memoryState(watching);
    const gmail = fakeGmail({
      arrived: ["a"],
      matching: ["a"],
      emailError: { a: new ExtensionError("gmail_rate_limited", "Gmail rate limit") },
    });
    const parse = parser();
    await checkForNewOrders(deps(state, gmail, parse));
    expect(parse).not.toHaveBeenCalled();
    expect(state.current.pending).toEqual([{ id: "a", attempts: 1 }]);
  });

  it("does not add a message twice when it is already pending", async () => {
    const state = memoryState({ ...watching, pending: [{ id: "a", attempts: 2 }] });
    const gmail = fakeGmail({ arrived: ["a"], matching: ["a"] });
    const parse = parser(() => new ExtensionError("proxy_unreachable", "down"));
    await checkForNewOrders(deps(state, gmail, parse));
    expect(state.current.pending).toEqual([{ id: "a", attempts: 3 }]);
  });

  it("saves the cursor and pending list before parsing, so a crash loses nothing", async () => {
    const state = memoryState(watching);
    const gmail = fakeGmail({ arrived: ["a"], matching: ["a"] });
    const parse = vi.fn<(req: ParseRequest) => Promise<ParseResponse>>(async () => {
      expect(state.current.historyId).toBe("600");
      expect(state.current.pending).toEqual([{ id: "a", attempts: 0 }]);
      throw new Error("worker killed");
    });
    await checkForNewOrders(deps(state, gmail, parse));
    expect(parse).toHaveBeenCalled();
  });

  it("falls back to a search when the history cursor expired", async () => {
    const state = memoryState(watching);
    const gmail = fakeGmail({
      historyId: "999",
      arrived: new HistoryExpiredError(),
      matching: ["x", "y"],
    });
    const parse = parser();
    const result = await checkForNewOrders(deps(state, gmail, parse));
    expect(gmail.searchIds).toHaveBeenNthCalledWith(1, ORDER_SEARCH_QUERY, 25);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ newOrders: 2 });
    expect(state.current.historyId).toBe("999");
  });

  it("propagates other Gmail errors without touching the cursor", async () => {
    const state = memoryState(watching);
    const gmail = fakeGmail({
      arrived: new ExtensionError("gmail_error", "Gmail returned HTTP 500"),
    });
    await expect(checkForNewOrders(deps(state, gmail, parser()))).rejects.toThrow("HTTP 500");
    expect(state.current.historyId).toBe("500");
  });

  it("stops and propagates when the session expires mid-run", async () => {
    const state = memoryState(watching);
    const gmail = fakeGmail({
      arrived: ["a", "b"],
      matching: ["a", "b"],
      emailError: { a: new ExtensionError("not_signed_in", "Sign in again") },
    });
    const parse = parser();
    await expect(checkForNewOrders(deps(state, gmail, parse))).rejects.toMatchObject({
      kind: "not_signed_in",
    });
    expect(parse).not.toHaveBeenCalled();
    expect(state.current.pending.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("keeps unseen increments made by others during the run", async () => {
    const state = memoryState({ ...watching, unseen: 1 });
    const gmail = fakeGmail({ arrived: ["a"], matching: ["a"] });
    const parse = parser((req) => {
      state.current.unseen = 0;
      return okParse(req);
    });
    await checkForNewOrders(deps(state, gmail, parse));
    expect(state.current.unseen).toBe(1);
  });
});
