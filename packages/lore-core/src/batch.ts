import type { PostgresTransaction } from "./db";

/** The bounds of one set-based batch: rows, and serialized JSON characters. */
export const RECORD_BATCH_LIMITS = {
  maximumRows: 5_000,
  maximumCharacters: 4_000_000,
} as const;

function* recordBatches(records: readonly object[]): Generator<string> {
  let pending: string[] = [];
  let characters = 0;
  for (const record of records) {
    const serialized = JSON.stringify(record);
    if (
      pending.length > 0 &&
      (pending.length >= RECORD_BATCH_LIMITS.maximumRows ||
        characters + serialized.length > RECORD_BATCH_LIMITS.maximumCharacters)
    ) {
      yield `[${pending.join(",")}]`;
      pending = [];
      characters = 0;
    }
    pending.push(serialized);
    characters += serialized.length + 1;
  }
  if (pending.length > 0) yield `[${pending.join(",")}]`;
}

/**
 * Run one set-based statement per bounded batch. `sql` reads its rows from
 * `jsonb_to_recordset($1::jsonb)`, so row-level security and row triggers apply to
 * every row exactly as they would to single-row statements. Returns the RETURNING
 * rows of every batch, in order.
 */
export async function queryInRecordBatches<Row extends object = { id: string }>(
  transaction: PostgresTransaction,
  sql: string,
  records: readonly object[],
  parameters: readonly unknown[] = [],
): Promise<Row[]> {
  const returned: Row[] = [];
  for (const batch of recordBatches(records)) {
    const result = await transaction.query<Row>(sql, [batch, ...parameters]);
    returned.push(...result.rows);
  }
  return returned;
}
