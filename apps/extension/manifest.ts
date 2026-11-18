export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export interface ManifestEnv {
  OAUTH_CLIENT_ID?: string | undefined;
  EXTENSION_PUBLIC_KEY?: string | undefined;
  PROXY_URL?: string | undefined;
}

export interface BuildSettings {
  clientId: string;
  publicKey: string;
  proxyUrl: string;
}

export function readBuildSettings(env: ManifestEnv): BuildSettings {
  const problems: string[] = [];
  const clientId = env.OAUTH_CLIENT_ID?.trim() ?? "";
  const publicKey = env.EXTENSION_PUBLIC_KEY?.trim() ?? "";
  const proxyRaw = env.PROXY_URL?.trim() || "http://127.0.0.1:8787";

  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    problems.push(
      "OAUTH_CLIENT_ID must be a Google OAuth client ID ending in .apps.googleusercontent.com",
    );
  }
  if (!/^[A-Za-z0-9+/]+=*$/.test(publicKey) || publicKey.length < 200) {
    problems.push("EXTENSION_PUBLIC_KEY must be the base64 public key printed by `pnpm gen:key`");
  }
  let proxyUrl = "";
  try {
    const url = new URL(proxyRaw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      problems.push("PROXY_URL must use https unless it points at localhost");
    }
    proxyUrl = url.origin;
  } catch {
    problems.push("PROXY_URL must be an absolute http(s) URL");
  }

  if (problems.length > 0) {
    throw new Error(
      `Extension build settings are invalid (apps/extension/.env):\n  - ${problems.join("\n  - ")}`,
    );
  }
  return { clientId, publicKey, proxyUrl };
}

export function buildManifest(s: BuildSettings) {
  return {
    manifest_version: 3,
    name: "Order Email Parser",
    description:
      "Reads order-confirmation emails from Gmail (read-only) and extracts structured order data.",
    version: "0.1.0",
    minimum_chrome_version: "116",
    key: s.publicKey,
    permissions: ["identity", "storage", "alarms"],
    host_permissions: [
      "https://gmail.googleapis.com/*",
      "https://oauth2.googleapis.com/*",
      `${s.proxyUrl}/*`,
    ],
    background: { service_worker: "background.js", type: "module" },
    action: { default_title: "Open Order Email Parser" },
    oauth2: { client_id: s.clientId, scopes: [GMAIL_READONLY_SCOPE] },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'",
    },
  };
}
