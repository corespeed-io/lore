// The one place the brain's bearer tokens are compared. /api/mcp, /api/import
// and /api/export all gate on this, so there is a single rule to reason about
// and a single place a mistake could live.
import { timingSafeEqual } from "node:crypto";

export type Access = "read" | "write";

function matches(presented: string, expected: string | undefined): boolean {
  // Refuse trivially guessable tokens outright: a 4-character BRAIN_WRITE_TOKEN
  // should not be a working credential just because someone set one.
  if (!expected || expected.length < 16) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Fail closed: no token, an unknown token, or an unconfigured server all yield
// null. A write token also grants read.
export function grantFor(
  authorization: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Access | null {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  if (matches(token, env.BRAIN_WRITE_TOKEN)) return "write";
  if (matches(token, env.BRAIN_READ_TOKEN)) return "read";
  return null;
}
