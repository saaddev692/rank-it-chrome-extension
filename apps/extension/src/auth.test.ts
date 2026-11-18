import { describe, expect, it, vi } from "vitest";
import { GMAIL_READONLY_SCOPE } from "../manifest.ts";
import { type AuthDeps, getAccessToken, signOut, withAccessToken } from "./auth.ts";
import { ExtensionError, UnauthorizedError } from "./errors.ts";

function fakeIdentity(tokens: (string | Error | { token?: string; grantedScopes?: string[] })[]) {
  const queue = [...tokens];
  const getAuthToken = vi.fn<
    (details: chrome.identity.TokenDetails) => Promise<{ token?: string; grantedScopes?: string[] }>
  >(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "string") return { token: next, grantedScopes: [GMAIL_READONLY_SCOPE] };
    return next ?? {};
  });
  const removeCachedAuthToken = vi.fn<(d: { token: string }) => Promise<void>>(async () => {});
  const clearAllCachedAuthTokens = vi.fn<() => Promise<void>>(async () => {});
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  const deps = {
    identity: { getAuthToken, removeCachedAuthToken, clearAllCachedAuthTokens },
    fetch: fetchMock,
  } as unknown as AuthDeps;
  return { deps, getAuthToken, removeCachedAuthToken, clearAllCachedAuthTokens, fetchMock };
}

describe("getAccessToken", () => {
  it("requests only the gmail.readonly scope with granular consent", async () => {
    const f = fakeIdentity(["tok"]);
    await expect(getAccessToken(true, f.deps)).resolves.toBe("tok");
    expect(f.getAuthToken).toHaveBeenCalledWith({
      interactive: true,
      scopes: [GMAIL_READONLY_SCOPE],
      enableGranularPermissions: true,
    });
  });

  it("reports not_signed_in when the silent request fails", async () => {
    const f = fakeIdentity([new Error("OAuth2 not granted or revoked.")]);
    await expect(getAccessToken(false, f.deps)).rejects.toMatchObject({ kind: "not_signed_in" });
  });

  it("reports a cancelled interactive sign-in as not_signed_in", async () => {
    const f = fakeIdentity([new Error("The user did not approve access.")]);
    await expect(getAccessToken(true, f.deps)).rejects.toMatchObject({ kind: "not_signed_in" });
  });

  it("reports other interactive failures as auth_failed", async () => {
    const f = fakeIdentity([new Error("bad client id")]);
    const err = await getAccessToken(true, f.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionError);
    expect((err as ExtensionError).kind).toBe("auth_failed");
    expect((err as ExtensionError).message).toContain("bad client id");
  });

  it("treats an empty result as not signed in", async () => {
    const f = fakeIdentity([{}]);
    await expect(getAccessToken(false, f.deps)).rejects.toMatchObject({ kind: "not_signed_in" });
  });

  it("rejects and evicts a token when the Gmail scope was unticked", async () => {
    const f = fakeIdentity([{ token: "tok", grantedScopes: ["openid"] }]);
    await expect(getAccessToken(true, f.deps)).rejects.toMatchObject({ kind: "scope_not_granted" });
    expect(f.removeCachedAuthToken).toHaveBeenCalledWith({ token: "tok" });
  });

  it("accepts results without grantedScopes (older Chrome)", async () => {
    const f = fakeIdentity([{ token: "tok" }]);
    await expect(getAccessToken(false, f.deps)).resolves.toBe("tok");
  });
});

describe("withAccessToken", () => {
  it("passes a silently obtained token to the callback", async () => {
    const f = fakeIdentity(["tok"]);
    await expect(withAccessToken(async (t) => `used ${t}`, f.deps)).resolves.toBe("used tok");
    expect(f.getAuthToken.mock.calls[0]![0].interactive).toBe(false);
  });

  it("on 401 evicts the stale token and retries once with a fresh one", async () => {
    const f = fakeIdentity(["stale", "fresh"]);
    const fn = vi.fn<(t: string) => Promise<string>>(async (t) => {
      if (t === "stale") throw new UnauthorizedError();
      return "ok";
    });
    await expect(withAccessToken(fn, f.deps)).resolves.toBe("ok");
    expect(f.removeCachedAuthToken).toHaveBeenCalledWith({ token: "stale" });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after a second 401 and asks the user to sign in", async () => {
    const f = fakeIdentity(["a", "b"]);
    const fn = vi.fn<(t: string) => Promise<string>>(async () => {
      throw new UnauthorizedError();
    });
    await expect(withAccessToken(fn, f.deps)).rejects.toMatchObject({ kind: "not_signed_in" });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(f.removeCachedAuthToken).toHaveBeenCalledWith({ token: "b" });
  });

  it("does not retry other errors", async () => {
    const f = fakeIdentity(["a"]);
    const fn = vi.fn<(t: string) => Promise<string>>(async () => {
      throw new ExtensionError("gmail_error", "boom");
    });
    await expect(withAccessToken(fn, f.deps)).rejects.toMatchObject({ kind: "gmail_error" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(f.removeCachedAuthToken).not.toHaveBeenCalled();
  });

  it("propagates a failed refresh after a 401", async () => {
    const f = fakeIdentity(["stale", new Error("revoked")]);
    const fn = vi.fn<(t: string) => Promise<string>>(async () => {
      throw new UnauthorizedError();
    });
    await expect(withAccessToken(fn, f.deps)).rejects.toMatchObject({ kind: "not_signed_in" });
  });
});

describe("signOut", () => {
  it("evicts the token, revokes it at Google and clears the cache", async () => {
    const f = fakeIdentity(["tok"]);
    await signOut(f.deps);
    expect(f.removeCachedAuthToken).toHaveBeenCalledWith({ token: "tok" });
    const [url, init] = f.fetchMock.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("token=tok");
    expect(f.clearAllCachedAuthTokens).toHaveBeenCalled();
  });

  it("still clears the cache when revocation fails", async () => {
    const f = fakeIdentity(["tok"]);
    f.fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await signOut(f.deps);
    expect(f.clearAllCachedAuthTokens).toHaveBeenCalled();
  });

  it("is a no-op revoke when not signed in", async () => {
    const f = fakeIdentity([new Error("not signed in")]);
    await signOut(f.deps);
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.clearAllCachedAuthTokens).toHaveBeenCalled();
  });
});
