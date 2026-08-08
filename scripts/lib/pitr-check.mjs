const MAX_RESTORE_DRILL_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

export function archiveCommandCheck(value) {
  const command = typeof value === "string" ? value.trim() : "";
  const normalized = command.replace(/\s+/g, " ").toLowerCase();
  const obviousNoOp = /^(?::|true|\/(?:usr\/)?bin\/true|exit 0)$/.test(normalized);
  if (!command || command === "(disabled)") {
    return { ok: false, detail: "disabled" };
  }
  if (obviousNoOp || !command.includes("%p")) {
    return { ok: false, detail: "unsafe or missing %p WAL path placeholder" };
  }
  return { ok: true, detail: "configured (redacted)" };
}

export function restoreDrillCheck(value, now = new Date()) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  const age = now.getTime() - timestamp;
  const ok =
    Number.isFinite(timestamp) && age >= -5 * 60 * 1_000 && age <= MAX_RESTORE_DRILL_AGE_MS;
  return {
    ok,
    detail: ok
      ? new Date(timestamp).toISOString()
      : "missing, invalid, future, or older than 90 days",
  };
}

export function archivedWalCheck(archiver) {
  const archivedCount = Number(archiver?.archived_count ?? 0);
  const lastArchivedAt = Date.parse(String(archiver?.last_archived_time ?? ""));
  const lastFailedAt = Date.parse(String(archiver?.last_failed_time ?? ""));
  const hasSuccess =
    archivedCount > 0 && Boolean(archiver?.last_archived_wal) && Number.isFinite(lastArchivedAt);
  const recoveredFromFailure = !Number.isFinite(lastFailedAt) || lastArchivedAt >= lastFailedAt;
  return {
    ok: hasSuccess && recoveredFromFailure,
    detail: hasSuccess
      ? recoveredFromFailure
        ? "latest observed archive attempt succeeded"
        : "latest observed archive attempt failed"
      : "no successful WAL archive has been observed",
  };
}
