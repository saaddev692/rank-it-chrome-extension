import { ORDER_SEARCH_QUERY, type ParseRequest, type ParseResponse } from "@oep/shared";
import { describe, expect, it, vi } from "vitest";
import { ExtensionError } from "./errors.ts";
import type { GmailClient, MessageSummary } from "./gmail.ts";
import {
  SEARCH_WINDOW,
  type SearchDeps,
  describeSummary,
  searchAndParse,
} from "./search-and-parse.ts";

const ACCOUNT = "me@gmail.com";

const messages: MessageSummary[] = [
  {
    id: "myt",
    from: "MYTHERESA <noreply@mytheresa.com>",
    subject: "Your order confirmation",
    date: null,
    snippet: "",
  },
  {
    id: "test",
    from: "REVOLVE <me@gmail.com>",
    subject: "Your order [TEST ORDER]",
    date: null,
    snippet: "",
  },
  {
    id: "gh",
    from: "GitHub <notifications@github.com>",
    subject: "Re: [org/repo] Fix test order",
    date: null,
    snippet: "",
  },
  {
    id: "known",
    from: "Selfridges <orders@selfridges.com>",
    subject: "Thanks for your order",
    date: null,
    snippet: "",
  },
];

function fakeGmail(failOn: Record<string, Error> = {}) {
  return {
    profile: vi.fn<GmailClient["profile"]>(),
    searchIds: vi.fn<GmailClient["searchIds"]>(),
    newInboxMessageIds: vi.fn<GmailClient["newInboxMessageIds"]>(),
    searchMessages: vi.fn<GmailClient["searchMessages"]>(async () => messages),
    getEmail: vi.fn<GmailClient["getEmail"]>(async (id) => {
      if (failOn[id]) throw failOn[id];
      const m = messages.find((x) => x.id === id)!;
      return {
        messageId: id,
        from: m.from,
        subject: m.subject,
        date: null,
        html: "<p>x</p>",
        text: null,
      };
    }),
  } satisfies GmailClient;
}

function setup(failOn: Record<string, Error> = {}, parseError?: Error) {
  const gmail = fakeGmail(failOn);
  const parse = vi.fn<(r: ParseRequest) => Promise<ParseResponse>>(async () => {
    if (parseError) throw parseError;
    return {} as ParseResponse;
  });
  const progress: [number, number][] = [];
  const deps: SearchDeps = {
    account: ACCOUNT,
    known: new Set(["known"]),
    withGmail: (fn) => fn(gmail),
    parse,
    onProgress: (d, t) => progress.push([d, t]),
  };
  return { gmail, parse, progress, deps };
}

describe("searchAndParse", () => {
  it("parses every allowed email not yet in history, and nothing else", async () => {
    const { gmail, parse, deps, progress } = setup();
    const summary = await searchAndParse(deps);

    expect(gmail.searchMessages).toHaveBeenCalledWith(ORDER_SEARCH_QUERY, SEARCH_WINDOW);
    expect(gmail.getEmail.mock.calls.map((c) => c[0])).toEqual(["myt", "test"]);
    expect(parse.mock.calls.map((c) => [c[0].email.messageId, c[0].source, c[0].account])).toEqual([
      ["myt", "manual", ACCOUNT],
      ["test", "manual", ACCOUNT],
    ]);
    expect(summary).toEqual({ found: 4, ignored: 1, alreadyInHistory: 1, parsed: 2, failures: [] });
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  it("never fetches or parses a GitHub email even though Gmail returned it", async () => {
    const { gmail, parse, deps } = setup();
    await searchAndParse(deps);
    expect(gmail.getEmail).not.toHaveBeenCalledWith("gh");
    expect(parse.mock.calls.some((c) => c[0].email.messageId === "gh")).toBe(false);
  });

  it("continues after a failure and reports it", async () => {
    const { parse, deps } = setup({
      myt: new ExtensionError("gmail_error", "Gmail returned HTTP 500"),
    });
    const summary = await searchAndParse(deps);
    expect(summary.parsed).toBe(1);
    expect(summary.failures).toEqual([
      { subject: "Your order confirmation", error: "Gmail returned HTTP 500" },
    ]);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("stops when the session expires", async () => {
    const { deps } = setup({ myt: new ExtensionError("not_signed_in", "Sign in again") });
    await expect(searchAndParse(deps)).rejects.toMatchObject({ kind: "not_signed_in" });
  });

  it("reports proxy failures per email", async () => {
    const { deps } = setup(
      {},
      new ExtensionError("proxy_unreachable", "Cannot reach the parsing proxy"),
    );
    const summary = await searchAndParse(deps);
    expect(summary.parsed).toBe(0);
    expect(summary.failures).toHaveLength(2);
  });
});

describe("describeSummary", () => {
  it("summarises every outcome", () => {
    expect(
      describeSummary({
        found: 5,
        ignored: 1,
        alreadyInHistory: 2,
        parsed: 1,
        failures: [{ subject: "s", error: "boom" }],
      }),
    ).toBe(
      "Parsed 1 new email · 2 already in history · 1 ignored (not from an allowed retailer and no [TEST ORDER] tag) · 1 failed: boom.",
    );
  });

  it("handles no results and plurals", () => {
    expect(
      describeSummary({ found: 0, ignored: 0, alreadyInHistory: 0, parsed: 0, failures: [] }),
    ).toBe("No matching emails found in Gmail.");
    expect(
      describeSummary({ found: 3, ignored: 0, alreadyInHistory: 0, parsed: 3, failures: [] }),
    ).toBe("Parsed 3 new emails.");
  });
});
