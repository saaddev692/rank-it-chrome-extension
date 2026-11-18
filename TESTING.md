# Testing

This project is tested in layers, from fast checks that run on every commit to manual checks against a real inbox. Setup for the real-inbox layers (Google OAuth, Gemini key, SMTP) is in the [README](README.md#setting-up-the-test-environment).

| Layer                                                             | Command                                           | Needs keys?            | Time                    | When                                          |
| ----------------------------------------------------------------- | ------------------------------------------------- | ---------------------- | ----------------------- | --------------------------------------------- |
| 1. Static analysis                                                | `pnpm lint` · `pnpm fmt:check` · `pnpm typecheck` | no                     | seconds                 | every commit (`pnpm check`)                   |
| 2. Unit tests                                                     | `pnpm test`                                       | no                     | about 2 s               | every commit                                  |
| 3. Component tests (HTTP app + SQLite)                            | `pnpm test`                                       | no                     | included above          | every commit                                  |
| 4. Contract tests                                                 | `pnpm test`                                       | no                     | included above          | every commit                                  |
| 5. Security tests                                                 | `pnpm test`                                       | no                     | included above          | every commit                                  |
| 6. Fixture tests (mock emails, expected output derived from data) | `pnpm test`                                       | no                     | included above          | every commit                                  |
| 7. Mutation testing                                               | `pnpm test:mutations`                             | no                     | about 30 s              | after changing tests or critical code         |
| 8. Live model evaluation                                          | `pnpm eval:live`                                  | Gemini key             | about 15 s, 3 API calls | after changing the prompt, model or templates |
| 9. Proxy smoke test                                               | `curl …` (below)                                  | Gemini key for parsing | 1 min                   | after changing server config                  |
| 10. End-to-end with a real inbox                                  | `pnpm send:test-emails` + the extension           | everything             | about 5 min             | before a demo or release                      |
| 11. Supply chain                                                  | `pnpm audit --audit-level=moderate`               | no                     | seconds                 | when adding or updating dependencies          |

`pnpm check` runs layers 1–6 together. The same commands are wired into `.pre-commit-config.yaml`; activate them with `prek install`.

## 1. Static analysis

- **oxlint** (`--deny-warnings`) runs the correctness, suspicious and perf categories with the TypeScript, unicorn, import, oxc and vitest plugins. Zero warnings are allowed; the few inline ignores each carry a justification comment.
- **tsc** runs in strict mode with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` and `erasableSyntaxOnly`, across all four workspace packages.
- **oxfmt** checks formatting. Embedded-language formatting is off, so `` html`…` `` email templates are never reflowed.

## 2. Unit tests

Run with Vitest. Server, shared and template tests run in Node; extension tests run in happy-dom. Only boundaries are mocked: `fetch` (Gmail, Gemini, the proxy), `chrome.identity` and `chrome.storage`. Parsing, validation, MIME decoding, HTML preprocessing and the watcher logic all run for real.

| File                                          | Tests | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/order-schema.test.ts`    |    17 | Valid and invalid orders; `javascript:` and `data:` image URLs rejected; negative prices, bad currency codes and non-ISO dates; email body required; account lowercased; unknown `source` rejected                                                                                                                                                                                                                                                    |
| `packages/shared/src/retailers.test.ts`       |    22 | Sender → retailer (subdomains OK; look-alike `revolve.com.evil.io` rejected); the fixed query includes all retailer domains and the `[TEST ORDER]` OR group                                                                                                                                                                                                                                                                                           |
| `packages/test-emails/src/index.test.ts`      |    28 | Auto-escaping `html` template tag; money and date formatters; for each retailer, every expected value appears in the rendered email, hostile data is escaped, and the expected order passes the schema; totals; sale price used; fresh order-number formats                                                                                                                                                                                           |
| `apps/server/src/preprocess.test.ts`          |    21 | HTML → prompt text for each mock email; hidden preheaders (with an injection attempt) dropped; 1×1 pixels, `data:`/`cid:`/relative images dropped; entities; table cells; `~~strike-through~~` prices; whitespace from HTML formatting not treated as line breaks; plain-text fallback; truncation; malformed HTML                                                                                                                                    |
| `apps/server/src/gemini.test.ts`              |    21 | Interactions API request shape (`store: false`, JSON schema, key in header not URL); 429 → rate limited; 4xx and 5xx; Google's array-wrapped errors ("API key not valid"); timeout; network failure; `failed`, `incomplete` and `requires_continuation` statuses; empty or non-JSON output                                                                                                                                                            |
| `apps/server/src/parse-order.test.ts`         |    16 | Valid output passes through; invented image URLs → `null`; tracking-pixel URL → `null`; retailer taken from the sender domain; normalisation (lowercase currency, empty strings); invalid model output rejected                                                                                                                                                                                                                                       |
| `apps/server/src/store.test.ts`               |     9 | History per account; upsert (re-parse); newest-first with limit; exact JSON round-trip; persisted to disk; no body columns; corrupt or old rows skipped and logged; `CHECK` constraint on `source`                                                                                                                                                                                                                                                    |
| `apps/server/src/config.test.ts`              |    12 | Defaults; required key and origins; placeholder or wildcard origins rejected; empty DB path rejected; the key is never echoed in errors                                                                                                                                                                                                                                                                                                               |
| `apps/extension/src/auth.test.ts`             |    15 | Only `gmail.readonly` requested with granular consent; cancelled sign-in; unticked permission → token evicted; 401 → evict → retry once; second 401 → sign in again; sign-out revokes and clears, even when offline                                                                                                                                                                                                                                   |
| `apps/extension/src/gmail.test.ts`            |    18 | Profile + history cursor; search; history pagination and de-duplication; expired cursor (404) → `HistoryExpiredError`; full message → `EmailPayload`; large bodies fetched as attachments; IDs URL-encoded; 401, 403, 429, 5xx and network errors                                                                                                                                                                                                     |
| `apps/extension/src/mime.test.ts`             |    17 | base64url round-trips; charsets (UTF-8, ISO-8859-1, unknown); nested multipart; attachments skipped                                                                                                                                                                                                                                                                                                                                                   |
| `apps/extension/src/watcher.test.ts`          |    17 | Disabled → no-op; first run records a baseline only; account switch re-baselines; only newly arrived **and** query-matching mail is parsed; no search when nothing arrived; history hits and non-orders don't count as new; failures retried, dropped after 5 attempts; oversized emails dropped; cursor and pending list saved **before** parsing; expired cursor → search fallback; session expiry stops the run; concurrent badge resets preserved |
| `apps/extension/src/search-and-parse.test.ts` |     7 | Search Gmail: only emails passing the strict rule are fetched and parsed (the GitHub "Fix test order" result is never fetched); already-parsed ones are skipped; per-email failures collected; session expiry stops it; progress and summary text                                                                                                                                                                                                     |
| `apps/extension/src/watch-state.test.ts`      |    12 | Defaults; older stored shapes merge cleanly; patch persists; **no token or query ever stored**; background message validation                                                                                                                                                                                                                                                                                                                         |
| `apps/extension/src/proxy-client.test.ts`     |    14 | Parse request carries account, source and force but **no Authorization header**; size limit counted in bytes; proxy down → setup hint; error-code mapping; history listing; malformed responses rejected                                                                                                                                                                                                                                              |
| `apps/extension/src/render.test.ts`           |    17 | History cards (summary, items, source badge); JSON shown exactly as stored; Re-parse wiring; only https images, with `no-referrer`; XSS payloads in subjects and item names render as text; auto-check status wording (queue count, next attempt, reason)                                                                                                                                                                                             |
| `apps/extension/src/manifest.test.ts`         |    14 | MV3 module worker; only the readonly scope; permissions exactly `identity`, `storage`, `alarms`; pinned key; CSP; invalid build settings rejected                                                                                                                                                                                                                                                                                                     |

## 3. Component tests

`apps/server/src/app.test.ts` (40 tests) drives the real Hono app through `app.request()` with a real in-memory SQLite store. Only Gemini is replaced, by a recording fake. It covers:

- parse → stored → returned;
- a second request for the same message is served from history (no Gemini call), case-insensitively by account;
- `force: true` re-parses and overwrites;
- failures aren't stored;
- `POST /v1/orders/list` returns only that account's records, newest first, hides records that fail the strict rule, and isn't available as GET;
- emails failing the strict sender/subject rule (GitHub, look-alike domain, lowercase tag) are refused with 422 before Gemini or storage;
- input validation (400), oversized bodies (413), and error-status mapping (429, 502, 504, 500 with details hidden);
- logs never contain email content, addresses or message IDs.

## 4. Contract tests

The extension and the proxy share Zod schemas from `packages/shared`, and both validate at the boundary: the proxy validates requests and model output, and the extension validates proxy responses. Two tests stop the contracts drifting:

- `parse-order.test.ts › RESPONSE_JSON_SCHEMA` checks that the JSON Schema sent to Gemini lists exactly the fields of `ParsedOrderSchema`, at both the order and item level, all required.
- `proxy-client.test.ts` rejects proxy responses that don't match `ParseResponseSchema` or `ListOrdersResponseSchema`.

## 5. Security tests

| Threat                                                                                             | Test                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A web page calls the localhost proxy (spends quota, reads history)                                 | `app.test.ts`: no Origin, web origin and other extension → 403, with no Gemini call; CORS preflight only for the extension |
| Google token leaks to the proxy                                                                    | `proxy-client.test.ts`: request headers are exactly `Content-Type`                                                         |
| Tokens persisted in extension storage                                                              | `watch-state.test.ts`: stored keys are exactly the state fields, and nothing matches `/token/i`                            |
| Over-broad OAuth scope or permissions                                                              | `auth.test.ts`, `manifest.test.ts`                                                                                         |
| Gmail permission unticked but token used anyway                                                    | `auth.test.ts`: scope check evicts the token                                                                               |
| Prompt injection hidden in the email                                                               | `preprocess.test.ts`: hidden preheader (with "Ignore all previous instructions…") is removed before prompting              |
| Model invents an image URL or points at a tracker                                                  | `parse-order.test.ts`: such URLs become `null`                                                                             |
| Look-alike sender domain                                                                           | `retailers.test.ts`                                                                                                        |
| Non-order mail parsed because Gmail search is punctuation-insensitive ("Fix test order" on GitHub) | `retailers.test.ts` (`isAllowedOrderEmail`), `search-and-parse.test.ts`, `watcher.test.ts`, `app.test.ts` (422)            |
| XSS through email subjects or item names                                                           | `render.test.ts`, plus hostile-data escaping in `test-emails`                                                              |
| Secrets in logs or errors                                                                          | `config.test.ts` (API key), `app.test.ts` (email content and identifiers), `gemini.test.ts` (key never in the URL)         |
| Raw emails kept at rest                                                                            | `store.test.ts`: no body columns in the table                                                                              |

## 6. Fixture tests (mock emails)

The mock emails are generated from data: `packages/test-emails/orders/*.json` holds the order, `src/templates/*.ts` holds the store's layout, and `expectedOrder()` derives the parser's expected JSON from the same data. The server tests load them through `fixture(name)`, which renders the email as if it came from the real retailer address.

To add a case, such as a multi-item order, a sale item or an unusual size, edit or add an order JSON. The rendered email, the preprocessing assertions, the pipeline tests and `pnpm eval:live` all follow automatically.

To add a retailer:

1. Add it to `RETAILERS` in `packages/shared/src/retailers.ts`.
2. Add a template in `packages/test-emails/src/templates/` and register it in `TEMPLATES`.
3. Add `orders/<name>.json`.

The parser itself needs no changes.

## 7. Mutation testing

`pnpm test:mutations` (`scripts/mutation-check.mjs`) applies 19 targeted mutations, one at a time, to security- and correctness-critical lines. Examples: removing the Origin check, skipping the strict sender rule in the proxy, Search or the watcher, listing history with GET, ignoring the account in history lookups, accepting invented image URLs, swapping `textContent` for `innerHTML`, making the watcher parse every new email instead of only query matches, and dropping retries. For each mutation it runs the whole suite and checks that it **fails**. Files are always restored afterwards.

The current result is 19/19 caught. A `SURVIVED` line means a test is missing; a `STALE` line means the code changed and the script's pattern needs updating.

## 8. Live model evaluation

`pnpm eval:live` sends the three mock emails to the real Gemini model, using `apps/server/.env`. It compares every field with the expected JSON (case-insensitive for text), prints `PASS`/`FAIL` with a per-field diff, and exits non-zero on any failure. Add `--verbose` to print the raw parsed JSON. Run it after any change to the prompt (`apps/server/src/prompt.ts`), the model (`GEMINI_MODEL`), the preprocessing, or the templates. When the prompt changes, bump `PROMPT_VERSION`.

## 9. Proxy smoke test

```bash
pnpm dev:server
curl -s http://127.0.0.1:8787/healthz                       # {"ok":true,"model":"gemini-3.8-flash"}
ORIGIN=chrome-extension://<your extension id>
curl -s -X POST http://127.0.0.1:8787/v1/orders/list -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"account":"you@gmail.com"}'   # {"records":[...]}
curl -s -X POST http://127.0.0.1:8787/v1/orders/list -H 'Content-Type: application/json' -d '{"account":"you@gmail.com"}'                        # 403 forbidden_origin
curl -s -X POST http://127.0.0.1:8787/v1/parse -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -d '{"account":"you@gmail.com","source":"manual","email":{"messageId":"smoke-1","from":"REVOLVE <orders@revolve.com>","subject":"Your order is confirmed","date":null,"html":"<p>Order #: RV1</p><img src=\"https://placehold.co/420x560/png\" width=\"140\"><p><b>superdown</b><br>Celine Heeled Sandal<br>Color: Gold<br>Size: 7.5<br><s>$88.00</s> $61.60</p><p>Total $61.60</p>","text":null}}'
```

With an invalid key, the last call returns `502 upstream_error … API key not valid`. That confirms the request reaches Google and the error is passed through.

## 10. End-to-end with a real inbox

This is the only layer that exercises Chrome's identity API, the real Gmail API (history, search, MIME), the background alarm, the proxy, Gemini and SQLite together. Follow **[README › Setting up the test environment](README.md#setting-up-the-test-environment)**, then the **[manual test plan](README.md#manual-test-plan)** (16 steps), which covers sign-in, auto-check, retry after a proxy outage, re-parse, Chrome restart, sign-out and account switching.

## 11. Supply chain

Dependencies are pinned to exact versions. pnpm refuses packages published less than 7 days ago (`minimumReleaseAge`) and doesn't run dependency install scripts (`ignoreScripts`). Run `pnpm audit --audit-level=moderate` before adding packages. Known open advisory: picomatch ReDoS (GHSA-fc5q-39xc-vjpf), which is dev-only, comes via vitest/vite, and has no patched release yet.

## Not covered by automated tests

- `app.ts` (DOM wiring of the extension page) and `background.ts` (Chrome event registration) are thin glue around tested modules (`watcher`, `render`, `auth`, `gmail`, `proxy-client`, `messages`). They're exercised by the end-to-end manual test, not by unit tests.
- Gmail's interpretation of the search query. Correctness doesn't depend on it: the strict rule decides what gets parsed, whatever Gmail returns. Manual test step 9 checks it end to end.
- Chrome's Origin behaviour (sent on POST, omitted on extension GETs) is browser behaviour that can't be reproduced in Vitest. The proxy-client test pins the POST, and manual step 4 (refresh) checks it in Chrome.
- Real SMTP delivery and spam filtering of the mock emails.
