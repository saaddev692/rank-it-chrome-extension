// Targeted mutation testing: breaks one security- or correctness-critical line at a time and
// checks that the test suite fails. A "SURVIVED" mutation means a regression there would ship
// unnoticed, so a test is missing.
//
//   pnpm test:mutations
//
// Each file is restored from memory after its run, even when a run throws.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MUTATIONS = [
  {
    label: "proxy: Origin allow-list removed",
    file: "apps/server/src/app.ts",
    find: "if (!origin || !deps.allowedOrigins.includes(origin)) {",
    replace: "if (false) {",
  },
  {
    label: "proxy: history lookup ignores account",
    file: "apps/server/src/store.ts",
    find: "WHERE account = ? AND message_id = ?",
    replace: "WHERE ? IS NOT NULL AND message_id = ?",
  },
  {
    label: "proxy: strict sender rule not enforced",
    file: "apps/server/src/app.ts",
    find: "if (!isAllowedOrderEmail(email)) {",
    replace: "if (false) {",
  },
  {
    label: "rule: test tag matched case-insensitively",
    file: "packages/shared/src/retailers.ts",
    find: "email.subject.includes(TEST_SUBJECT_TAG)",
    replace: "email.subject.toLowerCase().includes(TEST_SUBJECT_TAG.toLowerCase())",
  },
  {
    label: "search: strict rule not applied to Gmail results",
    file: "apps/extension/src/search-and-parse.ts",
    find: "results.filter((m) => isAllowedOrderEmail(m))",
    replace: "results",
  },
  {
    label: "search: already-parsed emails parsed again",
    file: "apps/extension/src/search-and-parse.ts",
    find: "allowed.filter((m) => !deps.known.has(m.id))",
    replace: "allowed",
  },
  {
    label: "watcher: strict rule not applied",
    file: "apps/extension/src/watcher.ts",
    find: "if (!isAllowedOrderEmail(email)) {",
    replace: "if (false) {",
  },
  {
    label: "proxy client: history listed with GET (no Origin from Chrome)",
    file: "apps/extension/src/proxy-client.ts",
    find: 'method: "POST",\n      headers: { "Content-Type": "application/json" },\n      body: JSON.stringify({ account }),',
    replace: 'method: "GET",',
  },
  {
    label: "proxy: force re-parse ignored",
    file: "apps/server/src/app.ts",
    find: "if (!force) {",
    replace: "if (true) {",
  },
  {
    label: "parser: image URL grounding removed",
    file: "apps/server/src/parse-order.ts",
    find: "!pre.imageUrls.has(item.imageUrl)",
    replace: "false",
  },
  {
    label: "preprocess: tracking-pixel filter removed",
    file: "apps/server/src/preprocess.ts",
    find: "return (w !== null && w <= 2) || (h !== null && h <= 2);",
    replace: "return false;",
  },
  {
    label: "preprocess: hidden-element filter removed",
    file: "apps/server/src/preprocess.ts",
    find: 'return style.includes("display:none")',
    replace: 'return false && style.includes("display:none")',
  },
  {
    label: "retailer: look-alike domains accepted",
    file: "packages/shared/src/retailers.ts",
    find: "domain.endsWith(`.${r.domain}`)",
    replace: "domain.includes(r.domain)",
  },
  {
    label: "auth: 401 retry removed",
    file: "apps/extension/src/auth.ts",
    find: "if (!(err instanceof UnauthorizedError)) throw err;",
    replace: "throw err;",
  },
  {
    label: "auth: granted-scope check removed",
    file: "apps/extension/src/auth.ts",
    find: "!result.grantedScopes.includes(GMAIL_READONLY_SCOPE)",
    replace: "false",
  },
  {
    label: "ui: textContent replaced by innerHTML",
    file: "apps/extension/src/render.ts",
    find: "node.textContent = text;",
    replace: "node.innerHTML = text;",
  },
  {
    label: "watcher: query filter removed (parses every new email)",
    file: "apps/extension/src/watcher.ts",
    find: "if (matching.has(id) && ",
    replace: "if (",
  },
  {
    label: "watcher: failed messages not retried",
    file: "apps/extension/src/watcher.ts",
    find: "remaining.push({ id: item.id, attempts });",
    replace: "failed++;",
  },
  {
    label: "watcher: account switch does not reset cursor",
    file: "apps/extension/src/watcher.ts",
    find: "if (initial.account !== account || initial.historyId === null) {",
    replace: "if (initial.historyId === null) {",
  },
];

let survived = 0;
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.find)) {
    console.log(`STALE     ${m.label}  (pattern not found in ${m.file}; update this script)`);
    survived++;
    continue;
  }
  try {
    writeFileSync(m.file, original.replace(m.find, m.replace));
    const run = spawnSync("pnpm", ["vitest", "run"], { stdio: "ignore" });
    if (run.status === 0) {
      console.log(`SURVIVED  ${m.label}`);
      survived++;
    } else {
      console.log(`caught    ${m.label}`);
    }
  } finally {
    writeFileSync(m.file, original);
  }
}

console.log(`\n${MUTATIONS.length - survived}/${MUTATIONS.length} mutations caught.`);
process.exit(survived === 0 ? 0 : 1);
