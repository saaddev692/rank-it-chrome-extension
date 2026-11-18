import { describe, expect, it } from "vitest";
import { GMAIL_READONLY_SCOPE, buildManifest, readBuildSettings } from "../manifest.ts";

const KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA" + "a".repeat(300) + "IDAQAB";
const env = {
  OAUTH_CLIENT_ID: "1234567890-abcdef.apps.googleusercontent.com",
  EXTENSION_PUBLIC_KEY: KEY,
  PROXY_URL: "http://127.0.0.1:8787/",
};

describe("readBuildSettings", () => {
  it("accepts valid settings and normalises the proxy URL to its origin", () => {
    expect(readBuildSettings(env)).toEqual({
      clientId: env.OAUTH_CLIENT_ID,
      publicKey: KEY,
      proxyUrl: "http://127.0.0.1:8787",
    });
  });

  it("defaults the proxy URL", () => {
    expect(readBuildSettings({ ...env, PROXY_URL: undefined }).proxyUrl).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it("allows https proxies anywhere", () => {
    expect(readBuildSettings({ ...env, PROXY_URL: "https://parser.example.com" }).proxyUrl).toBe(
      "https://parser.example.com",
    );
  });

  it.each([
    ["missing client id", { ...env, OAUTH_CLIENT_ID: "" }, "OAUTH_CLIENT_ID"],
    ["non-Google client id", { ...env, OAUTH_CLIENT_ID: "abc" }, "OAUTH_CLIENT_ID"],
    ["missing key", { ...env, EXTENSION_PUBLIC_KEY: undefined }, "EXTENSION_PUBLIC_KEY"],
    [
      "PEM-wrapped key",
      { ...env, EXTENSION_PUBLIC_KEY: `-----BEGIN PUBLIC KEY-----${KEY}` },
      "EXTENSION_PUBLIC_KEY",
    ],
    ["plain http to a remote host", { ...env, PROXY_URL: "http://parser.example.com" }, "https"],
    ["non-URL proxy", { ...env, PROXY_URL: "localhost:8787" }, "PROXY_URL"],
  ])("rejects %s", (_label, bad, message) => {
    expect(() => readBuildSettings(bad)).toThrow(message);
  });
});

describe("buildManifest", () => {
  const manifest = buildManifest(readBuildSettings(env));

  it("is MV3 with a module service worker", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
  });

  it("requests only the read-only Gmail scope", () => {
    expect(manifest.oauth2.scopes).toEqual([GMAIL_READONLY_SCOPE]);
    expect(manifest.oauth2.client_id).toBe(env.OAUTH_CLIENT_ID);
  });

  it("asks for the minimum permissions", () => {
    expect(manifest.permissions).toEqual(["identity", "storage", "alarms"]);
    expect(manifest.host_permissions).toEqual([
      "https://gmail.googleapis.com/*",
      "https://oauth2.googleapis.com/*",
      "http://127.0.0.1:8787/*",
    ]);
  });

  it("pins the extension ID with the public key", () => {
    expect(manifest.key).toBe(KEY);
  });

  it("disallows remote scripts", () => {
    expect(manifest.content_security_policy.extension_pages).toContain("script-src 'self'");
  });
});
