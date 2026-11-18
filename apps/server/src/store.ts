import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type OrderRecord, OrderRecordSchema, ParsedOrderSchema } from "@oep/shared";
import { PROMPT_VERSION } from "./prompt.ts";

/**
 * Order history, one row per (Gmail account, Gmail message). A message that is already stored is
 * never sent to Gemini again unless the caller asks for a re-parse. Only the parsed order and
 * a few headers are kept; raw email bodies are not stored.
 */
export interface OrderStore {
  get(account: string, messageId: string): OrderRecord | null;
  upsert(record: OrderRecord): void;
  list(account: string, limit?: number): OrderRecord[];
  close(): void;
}

interface Row {
  account: string;
  message_id: string;
  from_header: string;
  subject: string;
  email_date: string | null;
  source: string;
  model: string;
  order_json: string;
  parsed_at: string;
}

const COLUMNS =
  "account, message_id, from_header, subject, email_date, source, model, order_json, parsed_at";

/** Converts a row into a record, or null if the stored JSON no longer matches the schema. */
function toRecord(row: Row): OrderRecord | null {
  let order: unknown;
  try {
    order = JSON.parse(row.order_json);
  } catch {
    return null;
  }
  const parsedOrder = ParsedOrderSchema.safeParse(order);
  if (!parsedOrder.success) return null;
  const record = OrderRecordSchema.safeParse({
    account: row.account,
    messageId: row.message_id,
    from: row.from_header,
    subject: row.subject,
    emailDate: row.email_date,
    source: row.source,
    model: row.model,
    parsedAt: row.parsed_at,
    order: parsedOrder.data,
  });
  return record.success ? record.data : null;
}

export function openOrderStore(path: string, log: (msg: string) => void = () => {}): OrderStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS orders (
      account        TEXT NOT NULL,
      message_id     TEXT NOT NULL,
      from_header    TEXT NOT NULL,
      subject        TEXT NOT NULL,
      email_date     TEXT,
      source         TEXT NOT NULL CHECK (source IN ('manual', 'auto')),
      model          TEXT NOT NULL,
      prompt_version INTEGER NOT NULL,
      order_json     TEXT NOT NULL,
      parsed_at      TEXT NOT NULL,
      PRIMARY KEY (account, message_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS orders_by_account_time ON orders (account, parsed_at DESC);
  `);

  const select = db.prepare(`SELECT ${COLUMNS} FROM orders WHERE account = ? AND message_id = ?`);
  const upsert = db.prepare(`
    INSERT INTO orders (${COLUMNS}, prompt_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account, message_id) DO UPDATE SET
      from_header = excluded.from_header, subject = excluded.subject, email_date = excluded.email_date,
      source = excluded.source, model = excluded.model, order_json = excluded.order_json,
      parsed_at = excluded.parsed_at, prompt_version = excluded.prompt_version
  `);
  const listStmt = db.prepare(
    `SELECT ${COLUMNS} FROM orders WHERE account = ? ORDER BY parsed_at DESC, message_id LIMIT ?`,
  );

  return {
    get(account, messageId) {
      const row = select.get(account, messageId) as Row | undefined;
      if (!row) return null;
      const record = toRecord(row);
      if (!record) log(`ignoring unreadable history row for message ${messageId}`);
      return record;
    },
    upsert(r) {
      upsert.run(
        r.account,
        r.messageId,
        r.from,
        r.subject,
        r.emailDate,
        r.source,
        r.model,
        JSON.stringify(r.order),
        r.parsedAt,
        PROMPT_VERSION,
      );
    },
    list(account, limit = 500) {
      const rows = listStmt.all(account, limit) as unknown as Row[];
      const records: OrderRecord[] = [];
      for (const row of rows) {
        const record = toRecord(row);
        if (record) records.push(record);
        else log(`ignoring unreadable history row for message ${row.message_id}`);
      }
      return records;
    },
    close() {
      db.close();
    },
  };
}
