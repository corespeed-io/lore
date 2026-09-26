/**
 * The Workspace archive checksum: SHA-256 over the archive payload's canonical
 * JSON. Every exported archive carries it and every import verifies it, so this
 * serialization is a permanent format, independent of request-replay hashing,
 * which may change at any deploy. Never change it without a new archive format.
 *
 * Object keys sort with the default-locale `localeCompare`, as the first
 * `lore-workspace-v1` archives were written.
 */
function archiveCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(archiveCanonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${archiveCanonicalJson(item)}`)
    .join(",")}}`;
}

export async function workspaceArchiveChecksum(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(archiveCanonicalJson(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
