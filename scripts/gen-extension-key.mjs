// Generates an RSA key pair that pins the Chrome extension ID.
//
// Chrome derives an unpacked extension's ID from its path unless manifest.json has a "key".
// The Google OAuth client (type "Chrome Extension") is bound to one ID, and the proxy's
// ALLOWED_ORIGINS needs it too, so the ID must stay stable across machines and rebuilds.
//
//   pnpm gen:key            prints the public key + extension ID
//   pnpm gen:key --write    also writes EXTENSION_PUBLIC_KEY into apps/extension/.env
//
// The private key is only needed to publish to the Chrome Web Store; it is saved to
// extension-key.pem (gitignored). Keep it out of version control.
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pemPath = `${root}extension-key.pem`;
const envPath = `${root}apps/extension/.env`;

if (existsSync(pemPath)) {
  console.error(
    `${pemPath} already exists. Delete it first if you really want a new extension ID.`,
  );
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = publicKey.export({ type: "spki", format: "der" });
const publicKeyB64 = der.toString("base64");

// Extension ID = first 32 hex chars of sha256(DER public key), mapped 0-f -> a-p.
const extensionId = Array.from(createHash("sha256").update(der).digest("hex").slice(0, 32), (c) =>
  String.fromCharCode("a".charCodeAt(0) + Number.parseInt(c, 16)),
).join("");

writeFileSync(pemPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

if (process.argv.includes("--write")) {
  let env = existsSync(envPath)
    ? readFileSync(envPath, "utf8")
    : readFileSync(`${envPath}.example`, "utf8");
  env = /^EXTENSION_PUBLIC_KEY=.*$/m.test(env)
    ? env.replace(/^EXTENSION_PUBLIC_KEY=.*$/m, `EXTENSION_PUBLIC_KEY=${publicKeyB64}`)
    : `${env.trimEnd()}\nEXTENSION_PUBLIC_KEY=${publicKeyB64}\n`;
  writeFileSync(envPath, env);
  console.log(`Wrote EXTENSION_PUBLIC_KEY to ${envPath}`);
}

console.log(`
Extension ID:        ${extensionId}
Extension origin:    chrome-extension://${extensionId}
Private key saved:   ${pemPath}

EXTENSION_PUBLIC_KEY=${publicKeyB64}

Next:
  1. Put EXTENSION_PUBLIC_KEY in apps/extension/.env (or rerun with --write).
  2. Use the Extension ID as the "Item ID" when creating the Chrome Extension OAuth client.
  3. Set ALLOWED_ORIGINS=chrome-extension://${extensionId} in apps/server/.env.
`);
