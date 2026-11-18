import {
  ORDER_SEARCH_QUERY,
  type ParseRequest,
  type ParseResponse,
  isAllowedOrderEmail,
} from "@oep/shared";
import { ExtensionError } from "./errors.ts";
import type { GmailClient } from "./gmail.ts";

/** How many Gmail results to look at; non-allowed matches are filtered out locally. */
export const SEARCH_WINDOW = 50;

export interface SearchDeps {
  account: string;
  /** Message IDs already in the history DB; they are not fetched or parsed again. */
  known: ReadonlySet<string>;
  withGmail: <T>(fn: (gmail: GmailClient) => Promise<T>) => Promise<T>;
  parse: (request: ParseRequest) => Promise<ParseResponse>;
  onProgress?: (done: number, total: number) => void;
}

export interface SearchSummary {
  /** Results Gmail returned for the query. */
  found: number;
  /** Returned by Gmail but rejected by the strict sender/subject rule (e.g. GitHub mail). */
  ignored: number;
  alreadyInHistory: number;
  parsed: number;
  failures: { subject: string; error: string }[];
}

/**
 * "Search Gmail": runs the fixed query, keeps only emails that pass the strict rule, and parses
 * every one that is not in the history yet, so results land in the history as JSON without a
 * click per email. Failures are collected and the rest continue; an expired session stops it.
 */
export async function searchAndParse(deps: SearchDeps): Promise<SearchSummary> {
  return deps.withGmail(async (gmail) => {
    const results = await gmail.searchMessages(ORDER_SEARCH_QUERY, SEARCH_WINDOW);
    const allowed = results.filter((m) => isAllowedOrderEmail(m));
    const todo = allowed.filter((m) => !deps.known.has(m.id));

    const summary: SearchSummary = {
      found: results.length,
      ignored: results.length - allowed.length,
      alreadyInHistory: allowed.length - todo.length,
      parsed: 0,
      failures: [],
    };

    for (const [index, message] of todo.entries()) {
      deps.onProgress?.(index, todo.length);
      try {
        // oxlint-disable-next-line no-await-in-loop -- one at a time keeps Gemini under rate limits.
        const email = await gmail.getEmail(message.id);
        // oxlint-disable-next-line no-await-in-loop -- see above.
        await deps.parse({ account: deps.account, source: "manual", email });
        summary.parsed++;
      } catch (err) {
        if (err instanceof ExtensionError && err.kind === "not_signed_in") throw err;
        summary.failures.push({
          subject: message.subject,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    deps.onProgress?.(todo.length, todo.length);
    return summary;
  });
}

export function describeSummary(s: SearchSummary): string {
  if (s.found === 0) return "No matching emails found in Gmail.";
  const parts = [
    `Parsed ${s.parsed} new email${s.parsed === 1 ? "" : "s"}`,
    s.alreadyInHistory > 0 ? `${s.alreadyInHistory} already in history` : null,
    s.ignored > 0
      ? `${s.ignored} ignored (not from an allowed retailer and no [TEST ORDER] tag)`
      : null,
    s.failures.length > 0 ? `${s.failures.length} failed: ${s.failures[0]!.error}` : null,
  ];
  return `${parts.filter(Boolean).join(" · ")}.`;
}
