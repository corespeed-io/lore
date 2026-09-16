import type { PostgresDatabase } from "@corespeed/lore-core";

export async function purgeExpiredPortableCoreRecords(
  database: PostgresDatabase,
): Promise<{ idempotencyRecords: number; memoryEvents: number }> {
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{
      idempotency_records: string | number;
      memory_event_records: string | number;
    }>("SELECT * FROM lore.purge_expired_portable_core_records()");
    return {
      idempotencyRecords: Number(result.rows[0]?.idempotency_records ?? 0),
      memoryEvents: Number(result.rows[0]?.memory_event_records ?? 0),
    };
  });
}
