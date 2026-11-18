import { describe, expect, it, vi } from "vitest";
import { ExtensionError, UnauthorizedError } from "./errors.ts";
import { HistoryExpiredError, createGmailClient } from "./gmail.ts";
import { b64url } from "./test-helpers.ts";

type Routes = Record<string, Response | (() => Response)>;

function fakeFetch(routes: Routes) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input).replace("https://gmail.googleapis.com/gmail/v1/users/me", "");
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const r = routes[key]!;
    return typeof r === "function" ? r() : r.clone();
  });
}

const headers = [
  { name: "From", value: "REVOLVE <orders@email.revolve.com>" },
  { name: "Subject", value: "Your order is confirmed" },
  { name: "Date", value: "Tue, 27 Oct 2026 21:03:55 -0700" },
];

describe("createGmailClient", () => {
  it("sends the bearer token and reads the profile with its history cursor", async () => {
    const f = fakeFetch({
      "/profile": Response.json({ emailAddress: "me@example.com", historyId: 12345 }),
    });
    await expect(createGmailClient("tok", f).profile()).resolves.toEqual({
      emailAddress: "me@example.com",
      historyId: "12345",
    });
    const sentHeaders = f.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(sentHeaders["Authorization"]).toBe("Bearer tok");
  });

  it("searches messages and loads metadata for each", async () => {
    const f = fakeFetch({
      "/messages?": Response.json({ messages: [{ id: "m1" }, { id: "m2" }] }),
      "/messages/m1?format=metadata": Response.json({
        id: "m1",
        snippet: "Thanks",
        payload: { headers },
      }),
      "/messages/m2?format=metadata": Response.json({ id: "m2", payload: {} }),
    });
    const result = await createGmailClient("tok", f).searchMessages("from:(revolve.com)", 5);
    expect(result).toEqual([
      {
        id: "m1",
        from: "REVOLVE <orders@email.revolve.com>",
        subject: "Your order is confirmed",
        date: "Tue, 27 Oct 2026 21:03:55 -0700",
        snippet: "Thanks",
      },
      { id: "m2", from: "", subject: "(no subject)", date: null, snippet: "" },
    ]);
    const listUrl = new URL(String(f.mock.calls[0]![0]));
    expect(listUrl.searchParams.get("q")).toBe("from:(revolve.com)");
    expect(listUrl.searchParams.get("maxResults")).toBe("5");
  });

  it("returns an empty list when nothing matches", async () => {
    const f = fakeFetch({ "/messages?": Response.json({ resultSizeEstimate: 0 }) });
    await expect(createGmailClient("tok", f).searchMessages("q", 5)).resolves.toEqual([]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("builds an EmailPayload from a multipart message", async () => {
    const f = fakeFetch({
      "/messages/m1?format=full": Response.json({
        id: "m1",
        payload: {
          mimeType: "multipart/alternative",
          headers,
          parts: [
            { mimeType: "text/plain", body: { data: b64url("Rosalind Mini Dress $228.00") } },
            {
              mimeType: "text/html",
              body: { data: b64url("<p>Rosalind Mini Dress — $228.00</p>") },
            },
          ],
        },
      }),
    });
    await expect(createGmailClient("tok", f).getEmail("m1")).resolves.toEqual({
      messageId: "m1",
      from: "REVOLVE <orders@email.revolve.com>",
      subject: "Your order is confirmed",
      date: "Tue, 27 Oct 2026 21:03:55 -0700",
      html: "<p>Rosalind Mini Dress — $228.00</p>",
      text: "Rosalind Mini Dress $228.00",
    });
  });

  it("fetches large bodies stored as attachments", async () => {
    const f = fakeFetch({
      "/messages/m1?format=full": Response.json({
        id: "m1",
        payload: { mimeType: "text/html", headers, body: { size: 900000, attachmentId: "att/1" } },
      }),
      "/messages/m1/attachments/att%2F1": Response.json({ data: b64url("<p>big</p>") }),
    });
    expect((await createGmailClient("tok", f).getEmail("m1")).html).toBe("<p>big</p>");
  });

  it("returns null bodies for a message with no text parts", async () => {
    const f = fakeFetch({
      "/messages/m1?format=full": Response.json({
        id: "m1",
        payload: { mimeType: "image/png", headers },
      }),
    });
    const email = await createGmailClient("tok", f).getEmail("m1");
    expect(email.html).toBeNull();
    expect(email.text).toBeNull();
  });

  it("URL-encodes message ids", async () => {
    const f = fakeFetch({
      "/messages/a%2F..%2Fb?format=full": Response.json({ id: "x", payload: {} }),
    });
    await createGmailClient("tok", f).getEmail("a/../b");
    expect(String(f.mock.calls[0]![0])).toContain("/messages/a%2F..%2Fb?");
  });

  it("throws UnauthorizedError on 401 so the caller can refresh the token", async () => {
    const f = fakeFetch({ "/profile": new Response(null, { status: 401 }) });
    await expect(createGmailClient("tok", f).profile()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("maps 403 with Google's message", async () => {
    const f = fakeFetch({
      "/profile": Response.json(
        { error: { message: "Gmail API has not been used in project 123" } },
        { status: 403 },
      ),
    });
    const err = await createGmailClient("tok", f)
      .profile()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionError);
    expect((err as Error).message).toContain("Gmail API has not been used");
  });

  it.each([
    [429, "gmail_rate_limited"],
    [500, "gmail_error"],
    [404, "gmail_error"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const f = fakeFetch({ "/profile": new Response(null, { status }) });
    await expect(createGmailClient("tok", f).profile()).rejects.toMatchObject({ kind });
  });

  it("maps network failures", async () => {
    const f = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(createGmailClient("tok", f).profile()).rejects.toMatchObject({
      kind: "gmail_error",
    });
  });

  it("searchIds returns only message ids", async () => {
    const f = fakeFetch({ "/messages?": Response.json({ messages: [{ id: "a" }, { id: "b" }] }) });
    await expect(createGmailClient("tok", f).searchIds("q", 10)).resolves.toEqual(["a", "b"]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  describe("newInboxMessageIds", () => {
    it("collects added inbox messages across pages and returns the newest cursor", async () => {
      const pages = [
        {
          history: [{ messagesAdded: [{ message: { id: "m1" } }, { message: { id: "m2" } }] }],
          historyId: "150",
          nextPageToken: "p2",
        },
        {
          history: [
            { messagesAdded: [{ message: { id: "m2" } }] },
            {},
            { messagesAdded: [{ message: { id: "m3" } }] },
          ],
          historyId: "160",
        },
      ];
      const urls: URL[] = [];
      const f = vi.fn<typeof fetch>(async (input) => {
        urls.push(new URL(String(input)));
        return Response.json(pages[urls.length - 1]);
      });

      await expect(createGmailClient("tok", f).newInboxMessageIds("100")).resolves.toEqual({
        messageIds: ["m1", "m2", "m3"],
        historyId: "160",
      });
      expect(urls).toHaveLength(2);
      for (const url of urls) {
        expect(url.pathname).toMatch(/\/history$/);
        expect(url.searchParams.get("startHistoryId")).toBe("100");
        expect(url.searchParams.get("historyTypes")).toBe("messageAdded");
        expect(url.searchParams.get("labelId")).toBe("INBOX");
      }
      expect(urls[0]!.searchParams.get("pageToken")).toBeNull();
      expect(urls[1]!.searchParams.get("pageToken")).toBe("p2");
    });

    it("returns nothing and keeps the cursor when no mail arrived", async () => {
      const f = fakeFetch({ "/history?": Response.json({ historyId: "100" }) });
      await expect(createGmailClient("tok", f).newInboxMessageIds("100")).resolves.toEqual({
        messageIds: [],
        historyId: "100",
      });
    });

    it("throws HistoryExpiredError when Gmail no longer has the cursor (404)", async () => {
      const f = fakeFetch({ "/history?": new Response(null, { status: 404 }) });
      await expect(createGmailClient("tok", f).newInboxMessageIds("1")).rejects.toBeInstanceOf(
        HistoryExpiredError,
      );
    });

    it("still maps 401 to UnauthorizedError", async () => {
      const f = fakeFetch({ "/history?": new Response(null, { status: 401 }) });
      await expect(createGmailClient("tok", f).newInboxMessageIds("1")).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    });
  });
});
