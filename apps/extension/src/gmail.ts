import type { EmailPayload } from "@oep/shared";
import { ExtensionError, UnauthorizedError } from "./errors.ts";
import { type GmailMessagePart, decodePartData, findBodyParts, header } from "./mime.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface MessageSummary {
  id: string;
  from: string;
  subject: string;
  date: string | null;
  snippet: string;
}

export interface GmailProfile {
  emailAddress: string;
  /** Mailbox change cursor; pass it to `newInboxMessageIds` later to get what arrived since. */
  historyId: string;
}

interface GmailMessage {
  id: string;
  snippet?: string;
  payload?: GmailMessagePart;
}

interface HistoryPage {
  history?: { messagesAdded?: { message: { id: string } }[] }[];
  historyId?: string;
  nextPageToken?: string;
}

/** Gmail only keeps about a week of history; an older cursor returns 404. */
export class HistoryExpiredError extends Error {
  constructor() {
    super("Gmail history cursor expired");
    this.name = "HistoryExpiredError";
  }
}

export interface GmailClient {
  profile(): Promise<GmailProfile>;
  searchIds(query: string, maxResults: number): Promise<string[]>;
  searchMessages(query: string, maxResults: number): Promise<MessageSummary[]>;
  /** IDs of messages added to the inbox since `startHistoryId`, plus the new cursor. */
  newInboxMessageIds(startHistoryId: string): Promise<{ messageIds: string[]; historyId: string }>;
  getEmail(id: string): Promise<EmailPayload>;
}

/** Gmail REST client. Uses only read endpoints; the gmail.readonly scope could not do more anyway. */
export function createGmailClient(
  token: string,
  doFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): GmailClient {
  async function get<T>(path: string, on404?: () => Error): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      throw new ExtensionError("gmail_error", `Could not reach Gmail: ${(err as Error).message}`);
    }
    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 404 && on404) throw on404();
    if (res.status === 429) {
      throw new ExtensionError(
        "gmail_rate_limited",
        "Gmail rate limit reached. Try again in a minute.",
      );
    }
    if (res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new ExtensionError(
        "gmail_error",
        `Gmail refused the request: ${body.error?.message ?? "forbidden"}`,
      );
    }
    if (!res.ok) throw new ExtensionError("gmail_error", `Gmail returned HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async function partContent(
    messageId: string,
    part: GmailMessagePart | null,
  ): Promise<string | null> {
    if (!part) return null;
    if (part.body?.data) return decodePartData(part, part.body.data);
    if (part.body?.attachmentId) {
      const att = await get<{ data?: string }>(
        `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
      );
      return att.data ? decodePartData(part, att.data) : null;
    }
    return null;
  }

  async function searchIds(query: string, maxResults: number): Promise<string[]> {
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
    const list = await get<{ messages?: { id: string }[] }>(`/messages?${params}`);
    return (list.messages ?? []).map((m) => m.id);
  }

  return {
    async profile() {
      const p = await get<{ emailAddress: string; historyId: string }>("/profile");
      return { emailAddress: p.emailAddress, historyId: String(p.historyId) };
    },

    searchIds,

    async searchMessages(query, maxResults) {
      const ids = await searchIds(query, maxResults);
      const metaParams =
        "format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date";
      const messages = await Promise.all(
        ids.map((id) => get<GmailMessage>(`/messages/${encodeURIComponent(id)}?${metaParams}`)),
      );
      return messages.map((m) => ({
        id: m.id,
        from: (m.payload && header(m.payload, "From")) ?? "",
        subject: (m.payload && header(m.payload, "Subject")) ?? "(no subject)",
        date: (m.payload && header(m.payload, "Date")) ?? null,
        snippet: m.snippet ?? "",
      }));
    },

    async newInboxMessageIds(startHistoryId) {
      const ids = new Set<string>();
      let pageToken: string | undefined;
      let latest = startHistoryId;
      do {
        const params = new URLSearchParams({
          startHistoryId,
          historyTypes: "messageAdded",
          labelId: "INBOX",
        });
        if (pageToken) params.set("pageToken", pageToken);
        // oxlint-disable-next-line no-await-in-loop -- pages must be fetched in order (each needs the previous token).
        const page = await get<HistoryPage>(`/history?${params}`, () => new HistoryExpiredError());
        for (const h of page.history ?? []) {
          for (const added of h.messagesAdded ?? []) ids.add(added.message.id);
        }
        if (page.historyId) latest = String(page.historyId);
        pageToken = page.nextPageToken;
      } while (pageToken);
      return { messageIds: [...ids], historyId: latest };
    },

    async getEmail(id) {
      const msg = await get<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
      const payload = msg.payload ?? {};
      const { html, text } = findBodyParts(payload);
      const [htmlBody, textBody] = await Promise.all([
        partContent(id, html),
        partContent(id, text),
      ]);
      return {
        messageId: msg.id,
        from: header(payload, "From") ?? "",
        subject: header(payload, "Subject") ?? "",
        date: header(payload, "Date"),
        html: htmlBody,
        text: textBody,
      };
    },
  };
}
