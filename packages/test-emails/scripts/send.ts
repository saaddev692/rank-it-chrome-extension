/**
 * Sends mock order-confirmation emails so they land in a real Gmail inbox.
 *
 *   pnpm send:test-emails --to you@gmail.com                    # one of each retailer
 *   pnpm send:test-emails --to you@gmail.com --template revolve --count 3
 *   pnpm send:test-emails --to you@gmail.com --dry-run --out ./preview   # no SMTP, writes .html files
 *
 * Each email gets a fresh order number and today's date, and "[TEST ORDER]" in the subject.
 * SMTP settings come from packages/test-emails/.env (see .env.example).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createTransport } from "nodemailer";
import {
  TEMPLATE_NAMES,
  TEST_SUBJECT_TAG,
  type TemplateName,
  freshOrder,
  isTemplateName,
  loadOrder,
  renderEmail,
} from "../src/index.ts";

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function fail(message: string): never {
  console.error(
    `Error: ${message}\n\nUsage: pnpm send:test-emails --to you@gmail.com [--template mytheresa|selfridges|revolve] [--count N] [--dry-run --out DIR]`,
  );
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    to: { type: "string", multiple: true },
    template: { type: "string", multiple: true },
    count: { type: "string", default: "1" },
    "dry-run": { type: "boolean", default: false },
    out: { type: "string", default: "./preview" },
  },
  strict: true,
});

const recipients = values.to ?? [];
if (recipients.length === 0) fail("--to is required");
for (const to of recipients) if (!EMAIL.test(to)) fail(`"${to}" is not an email address`);

const requested = values.template ?? TEMPLATE_NAMES;
const templates: TemplateName[] = [];
for (const name of requested) {
  if (!isTemplateName(name))
    fail(`unknown template "${name}" (choose from ${TEMPLATE_NAMES.join(", ")})`);
  templates.push(name);
}

const count = Number.parseInt(values.count, 10);
if (!Number.isInteger(count) || count < 1 || count > 20) fail("--count must be between 1 and 20");

const emails = templates.flatMap((name) =>
  Array.from({ length: count }, () => {
    const order = freshOrder(name, loadOrder(name));
    return { name, order, rendered: renderEmail(name, order) };
  }),
);

if (values["dry-run"]) {
  const dir = resolve(values.out);
  mkdirSync(dir, { recursive: true });
  for (const { name, order, rendered } of emails) {
    const file = `${dir}/${name}-${order.orderNumber}.html`;
    writeFileSync(file, rendered.html);
    console.log(`wrote ${file}  (subject: ${rendered.subject} ${TEST_SUBJECT_TAG})`);
  }
  process.exit(0);
}

const env = process.env;
const host = env["SMTP_HOST"];
const user = env["SMTP_USER"];
const pass = env["SMTP_PASS"];
if (!host || !user || !pass) {
  fail("SMTP_HOST, SMTP_USER and SMTP_PASS must be set in packages/test-emails/.env");
}
const port = Number.parseInt(env["SMTP_PORT"] ?? "465", 10);
const transport = createTransport({
  host,
  port,
  secure: (env["SMTP_SECURE"] ?? String(port === 465)) === "true",
  auth: { user, pass },
});
const fromAddress = env["SMTP_FROM_ADDRESS"] || user;

try {
  await transport.verify();
} catch (err) {
  fail(`could not log in to ${host}:${port} – ${(err as Error).message}`);
}

let sent = 0;
for (const { rendered, order } of emails) {
  for (const to of recipients) {
    // oxlint-disable-next-line no-await-in-loop -- sequential on purpose: SMTP providers throttle bursts.
    const info = await transport.sendMail({
      from: { name: rendered.fromName, address: fromAddress },
      to,
      subject: `${rendered.subject} ${TEST_SUBJECT_TAG}`,
      html: rendered.html,
      text: rendered.text,
    });
    sent++;
    console.log(`sent ${order.retailer} ${order.orderNumber} -> ${to} (${info.messageId})`);
  }
}
transport.close();
console.log(
  `\n${sent} email(s) sent. In the extension, they are picked up by auto-check or "Search Gmail".`,
);
