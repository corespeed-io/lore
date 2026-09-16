import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_RESTORE_DRILL_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

export function archiveCommandCheck(value) {
  const command = typeof value === "string" ? value.trim() : "";
  const normalized = command.replace(/\s+/g, " ").toLowerCase();
  const unquoted = normalized.replaceAll(/['"]/g, "");
  const tokens = unquoted.split(" ");
  const executable = tokens[0];
  const shellPayload = ["sh", "bash", "zsh"].includes(executable)
    ? tokens.slice(tokens[1] === "-c" ? 2 : 1).join(" ")
    : "";
  const obviousNoOp =
    executable === ":" ||
    executable === "true" ||
    executable === "/bin/true" ||
    executable === "/usr/bin/true" ||
    (executable === "exit" && tokens[1] === "0") ||
    /^(?::|true|\/(?:usr\/)?bin\/true|exit 0)(?:\s|$)/.test(shellPayload);
  if (!command || command === "(disabled)") {
    return { ok: false, detail: "disabled" };
  }
  if (obviousNoOp || !command.includes("%p")) {
    return { ok: false, detail: "unsafe or missing %p WAL path placeholder" };
  }
  return { ok: true, detail: "configured (redacted)" };
}

export async function archivedWalArtifactCheck(directory, walName) {
  if (typeof directory !== "string" || !directory.trim()) {
    return { ok: false, detail: "LORE_PITR_ARCHIVE_DIRECTORY is required" };
  }
  if (typeof walName !== "string" || !/^[0-9A-F]{24}$/.test(walName)) {
    return { ok: false, detail: "latest archived WAL name is unavailable" };
  }
  try {
    const artifact = await lstat(resolve(directory, walName));
    return artifact.isFile() && artifact.size > 0
      ? { ok: true, detail: "latest WAL artifact exists (path redacted)" }
      : { ok: false, detail: "latest WAL artifact is not a non-empty regular file" };
  } catch {
    return { ok: false, detail: "latest WAL artifact is unavailable" };
  }
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
