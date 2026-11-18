import { GMAIL_READONLY_SCOPE } from "../manifest.ts";
import { ExtensionError, UnauthorizedError } from "./errors.ts";

/**
 * Token handling, in short:
 * - Chrome's identity API owns the OAuth grant. The refresh token never reaches this code;
 *   Chrome keeps it in the browser profile and refreshes access tokens itself.
 * - Access tokens are short-lived (about 1 hour). We ask Chrome for one per operation and keep it
 *   only in a local variable. Nothing is written to chrome.storage, localStorage or IndexedDB.
 * - If Google answers 401 (expired or revoked token), we evict that token from Chrome's cache
 *   and ask again once. Chrome then refreshes silently or reports that sign-in is needed.
 * - Sign-out evicts the token, revokes the grant at Google and clears Chrome's token cache.
 * - The token is only ever sent to gmail.googleapis.com and oauth2.googleapis.com, never to the parsing proxy.
 */

export interface AuthDeps {
  identity: Pick<
    typeof chrome.identity,
    "getAuthToken" | "removeCachedAuthToken" | "clearAllCachedAuthTokens"
  >;
  fetch: typeof fetch;
}

const defaultDeps = (): AuthDeps => ({
  identity: chrome.identity,
  fetch: globalThis.fetch.bind(globalThis),
});

export async function getAccessToken(
  interactive: boolean,
  deps: AuthDeps = defaultDeps(),
): Promise<string> {
  let result: chrome.identity.GetAuthTokenResult;
  try {
    result = await deps.identity.getAuthToken({
      interactive,
      scopes: [GMAIL_READONLY_SCOPE],
      enableGranularPermissions: true,
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (!interactive) throw new ExtensionError("not_signed_in", "Sign in with Google to continue.");
    if (/did not approve|canceled|cancelled|closed/i.test(message)) {
      throw new ExtensionError("not_signed_in", "Sign-in was cancelled.");
    }
    throw new ExtensionError("auth_failed", `Google sign-in failed: ${message}`);
  }

  if (!result.token) throw new ExtensionError("not_signed_in", "Sign in with Google to continue.");

  // With granular consent the user can untick the Gmail permission while still signing in.
  if (result.grantedScopes && !result.grantedScopes.includes(GMAIL_READONLY_SCOPE)) {
    await deps.identity.removeCachedAuthToken({ token: result.token });
    throw new ExtensionError(
      "scope_not_granted",
      'Gmail read access was not granted. Sign in again and tick "Read your email messages and settings".',
    );
  }
  return result.token;
}

/**
 * Runs `fn` with a fresh access token. If it throws UnauthorizedError the token is evicted
 * from Chrome's cache and `fn` is retried exactly once with a newly issued token.
 */
export async function withAccessToken<T>(
  fn: (token: string) => Promise<T>,
  deps: AuthDeps = defaultDeps(),
): Promise<T> {
  const token = await getAccessToken(false, deps);
  try {
    return await fn(token);
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
    await deps.identity.removeCachedAuthToken({ token });
    const fresh = await getAccessToken(false, deps);
    try {
      return await fn(fresh);
    } catch (retryErr) {
      if (retryErr instanceof UnauthorizedError) {
        await deps.identity.removeCachedAuthToken({ token: fresh });
        throw new ExtensionError(
          "not_signed_in",
          "Google rejected the session. Please sign in again.",
        );
      }
      throw retryErr;
    }
  }
}

export async function signOut(deps: AuthDeps = defaultDeps()): Promise<void> {
  let token: string | null = null;
  try {
    token = await getAccessToken(false, deps);
  } catch {
    // Not signed in: nothing to revoke.
  }
  if (token) {
    await deps.identity.removeCachedAuthToken({ token });
    try {
      await deps.fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      });
    } catch {
      // Revocation is best effort. The local cache is cleared below either way.
    }
  }
  await deps.identity.clearAllCachedAuthTokens();
}
