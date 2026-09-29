import type { WorkspaceArchiveFormat } from "./limits";

/**
 * The Workspace archive checksum: SHA-256 over the archive payload's canonical
 * JSON. Every exported archive carries it and every import verifies it, so each
 * format's serialization is permanent, independent of request-replay hashing, which
 * may change at any deploy. Never change one; add a format instead.
 *
 * The formats differ only in how object keys sort:
 * - `lore-workspace-v1` sorts them with the default-locale `localeCompare`, as the
 *   first archives were written. A runtime's collation decides that order.
 * - `lore-workspace-v2` sorts them by UTF-16 code unit, the same in every runtime.
 */
const KEY_ORDER: Readonly<Record<WorkspaceArchiveFormat, (left: string, right: string) => number>> =
  {
    "lore-workspace-v1": (left, right) => left.localeCompare(right),
    "lore-workspace-v2": (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  };

function archiveCanonicalJson(
  value: unknown,
  order: (left: string, right: string) => number,
): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => archiveCanonicalJson(item, order)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => order(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${archiveCanonicalJson(item, order)}`)
    .join(",")}}`;
}

export async function workspaceArchiveChecksum(
  payload: unknown,
  format: WorkspaceArchiveFormat,
): Promise<string> {
  const bytes = new TextEncoder().encode(archiveCanonicalJson(payload, KEY_ORDER[format]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
