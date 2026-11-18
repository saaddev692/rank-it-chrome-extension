import {
  ORDER_SEARCH_QUERY,
  type ParseRequest,
  type ParseResponse,
  isAllowedOrderEmail,
} from "@oep/shared";
import { ExtensionError } from "./errors.ts";
import { type GmailClient, HistoryExpiredError } from "./gmail.ts";
import type { WatchStateStore } from "./watch-state.ts";

/** Give up on a message after this many failed parse attempts (about this many minutes). */
export const MAX_ATTEMPTS = 5;
/** How deep to look in the query results when matching newly arrived messages. */
const MATCH_WINDOW = 100;

export interface WatcherDeps {
  state: WatchStateStore;
  withGmail: <T>(fn: (gmail: GmailClient) => Promise<T>) => Promise<T>;
  parse: (request: ParseRequest) => Promise<ParseResponse>;
  now?: () => Date;
}

export type CheckResult =
  | { status: "disabled" }
  | { status: "baseline"; account: string }
  | {
      status: "checked";
      account: string;
      newOrders: number;
      pending: number;
      failed: number;
      /** Matched the Gmail query but not the strict sender/subject rule, so never parsed. */
      ignored: number;
    };

/**
 * One auto-check pass:
 * 1. Read the mailbox's history since the saved cursor and collect messages added to the inbox.
 * 2. Keep those that match ORDER_SEARCH_QUERY (Gmail evaluates the query, so it supports the full
 *    search syntax) and add them to the pending list, which is saved before any parsing starts.
 * 3. Fetch each pending message, drop it unless it passes the strict rule (isAllowedOrderEmail:
 *    retailer domain or literal "[TEST ORDER]" tag), and parse the rest through the proxy, which
 *    stores them in the history DB.
 *    Failures stay pending and are retried on later checks, up to MAX_ATTEMPTS.
 * The first run for an account only records the cursor: existing mail is not back-filled
 * (use "Search Gmail" for that).
 */
export async function checkForNewOrders(deps: WatcherDeps): Promise<CheckResult> {
  const now = deps.now ?? (() => new Date());
  const initial = await deps.state.get();
  if (!initial.enabled) return { status: "disabled" };

  return deps.withGmail(async (gmail) => {
    const profile = await gmail.profile();
    const account = profile.emailAddress.toLowerCase();

    if (initial.account !== account || initial.historyId === null) {
      await deps.state.patch({
        account,
        historyId: profile.historyId,
        pending: [],
        lastCheckedAt: now().toISOString(),
        lastError: null,
      });
      return { status: "baseline", account };
    }

    let arrived: string[];
    let historyId: string;
    try {
      ({ messageIds: arrived, historyId } = await gmail.newInboxMessageIds(initial.historyId));
    } catch (err) {
      if (!(err instanceof HistoryExpiredError)) throw err;
      // Cursor too old (extension idle for a week+): treat recent matches as candidates.
      // Messages already in the history DB are answered from it without calling Gemini.
      arrived = await gmail.searchIds(ORDER_SEARCH_QUERY, 25);
      historyId = profile.historyId;
    }

    const pending = [...initial.pending];
    if (arrived.length > 0) {
      const matching = new Set(await gmail.searchIds(ORDER_SEARCH_QUERY, MATCH_WINDOW));
      for (const id of arrived) {
        if (matching.has(id) && !pending.some((p) => p.id === id))
          pending.push({ id, attempts: 0 });
      }
    }
    // Persist the cursor and the work list first, so nothing is lost if the worker is stopped.
    await deps.state.patch({ historyId, pending });

    let newOrders = 0;
    let failed = 0;
    let ignored = 0;
    let lastError: string | null = null;
    const remaining: { id: string; attempts: number }[] = [];
    for (const item of pending) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one at a time keeps Gemini under rate limits.
        const email = await gmail.getEmail(item.id);
        if (!isAllowedOrderEmail(email)) {
          ignored++;
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- see above.
        const res = await deps.parse({ account, source: "auto", email });
        if (!res.cached && res.record.order.isOrderConfirmation) newOrders++;
      } catch (err) {
        if (err instanceof ExtensionError && err.kind === "not_signed_in") throw err;
        lastError = err instanceof Error ? err.message : String(err);
        const attempts = item.attempts + 1;
        if (
          attempts < MAX_ATTEMPTS &&
          !(err instanceof ExtensionError && err.kind === "email_too_large")
        ) {
          remaining.push({ id: item.id, attempts });
        } else {
          failed++;
        }
      }
    }

    const latest = await deps.state.get();
    await deps.state.patch({
      pending: remaining,
      lastCheckedAt: now().toISOString(),
      lastError,
      unseen: latest.unseen + newOrders,
    });
    return {
      status: "checked",
      account,
      newOrders,
      pending: remaining.length,
      failed,
      ignored,
    };
  });
}
