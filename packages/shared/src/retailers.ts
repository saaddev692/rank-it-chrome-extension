export const RETAILERS = [
  { name: "Mytheresa", domain: "mytheresa.com" },
  { name: "Selfridges", domain: "selfridges.com" },
  { name: "Revolve", domain: "revolve.com" },
] as const;

export type RetailerName = (typeof RETAILERS)[number]["name"];

/** Subject tag added by `pnpm send:test-emails`; mock emails come from your own address. */
export const TEST_SUBJECT_TAG = "[TEST ORDER]";

/**
 * The fixed Gmail query used by auto-check and "Search Gmail": order-like emails that are either
 * from a supported retailer or tagged as a mock test email. `{a b}` is Gmail's OR group.
 */
export function buildOrderSearchQuery(newerThan = "2y"): string {
  const senders = RETAILERS.map((r) => r.domain).join(" OR ");
  return `{from:(${senders}) subject:"${TEST_SUBJECT_TAG}"} subject:(order OR confirmation OR confirmed OR "thank you") newer_than:${newerThan}`;
}

export const ORDER_SEARCH_QUERY = buildOrderSearchQuery();

function senderDomain(from: string): string | null {
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const at = address.lastIndexOf("@");
  if (at === -1) return null;
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/[>\s].*$/, "");
}

/**
 * Identifies the retailer from the From header. Matches the domain or any subdomain
 * (e.g. `email.revolve.com`) but not look-alikes such as `revolve.com.evil.io`.
 */
export function detectRetailer(from: string): RetailerName | null {
  const domain = senderDomain(from);
  if (!domain) return null;
  const match = RETAILERS.find((r) => domain === r.domain || domain.endsWith(`.${r.domain}`));
  return match?.name ?? null;
}

/**
 * The strict rule for which emails may be parsed. Gmail search ignores punctuation, so the query
 * above is only a pre-filter (`subject:"[TEST ORDER]"` also matches "fix test order" on GitHub).
 * This check is the authority: a supported retailer's sender domain, or the literal test tag.
 * It is applied by Search, by auto-check and again by the proxy before anything reaches Gemini.
 */
export function isAllowedOrderEmail(email: { from: string; subject: string }): boolean {
  return detectRetailer(email.from) !== null || email.subject.includes(TEST_SUBJECT_TAG);
}
