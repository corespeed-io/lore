import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const settings = await client.query(
    `SELECT
       current_setting('wal_level') AS wal_level,
       current_setting('archive_mode') AS archive_mode,
       current_setting('archive_command') AS archive_command,
       current_setting('archive_timeout') AS archive_timeout,
       current_setting('data_checksums') AS data_checksums,
       current_setting('max_wal_senders')::integer AS max_wal_senders`,
  );
  const archiver = await client.query(
    `SELECT archived_count, failed_count, last_archived_wal, last_archived_time,
            last_failed_wal, last_failed_time
     FROM pg_stat_archiver`,
  );
  const row = settings.rows[0];
  const checks = [
    {
      check: "wal_level",
      ok: row.wal_level === "replica" || row.wal_level === "logical",
      detail: row.wal_level,
    },
    {
      check: "archive_mode",
      ok: row.archive_mode === "on" || row.archive_mode === "always",
      detail: row.archive_mode,
    },
    {
      check: "archive_command",
      ok: Boolean(row.archive_command && row.archive_command !== "(disabled)"),
      detail: row.archive_command || "empty",
    },
    {
      check: "wal_senders",
      ok: row.max_wal_senders >= 1,
      detail: String(row.max_wal_senders),
    },
    {
      check: "data_checksums",
      ok: row.data_checksums === "on",
      detail: row.data_checksums,
      advisory: true,
    },
    {
      check: "archive_failures",
      ok: Number(archiver.rows[0]?.failed_count ?? 0) === 0,
      detail: String(archiver.rows[0]?.failed_count ?? 0),
    },
  ];
  const report = {
    ok: checks.every((check) => check.ok || check.advisory),
    checks,
    archiveTimeout: row.archive_timeout,
    archiver: archiver.rows[0] ?? null,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  await client.end();
}
