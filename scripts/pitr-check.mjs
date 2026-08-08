import pg from "pg";
import {
  archiveCommandCheck,
  archivedWalArtifactCheck,
  archivedWalCheck,
  restoreDrillCheck,
} from "./lib/pitr-check.mjs";

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
  const archiveCommand = archiveCommandCheck(row.archive_command);
  const archivedWal = archivedWalCheck(archiver.rows[0]);
  const archivedWalArtifact = await archivedWalArtifactCheck(
    process.env.LORE_PITR_ARCHIVE_DIRECTORY,
    archiver.rows[0]?.last_archived_wal,
  );
  const restoreDrill = restoreDrillCheck(process.env.LORE_PITR_RESTORE_DRILL_CONFIRMED_AT);
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
      ...archiveCommand,
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
      check: "archive_progress",
      ...archivedWal,
    },
    {
      check: "archive_artifact",
      ...archivedWalArtifact,
    },
    {
      check: "restore_drill",
      ...restoreDrill,
    },
  ];
  const report = {
    ok: checks.every((check) => check.ok || check.advisory),
    checks,
    archiveTimeout: row.archive_timeout,
    archiver: archiver.rows[0]
      ? {
          archivedCount: Number(archiver.rows[0].archived_count),
          failedCount: Number(archiver.rows[0].failed_count),
          lastArchivedWal: archiver.rows[0].last_archived_wal,
          lastArchivedTime: archiver.rows[0].last_archived_time,
          lastFailedWal: archiver.rows[0].last_failed_wal,
          lastFailedTime: archiver.rows[0].last_failed_time,
        }
      : null,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  await client.end();
}
