// The one place the brain's bearer tokens are parsed and compared. /api/mcp,
// /api/import and /api/export gate on this, and so does src/middleware.ts, so
// there is a single rule to reason about and a single place a mistake could live.
//
// NO node: IMPORTS, deliberately. The middleware runs in the Edge runtime, where
// `node:crypto` and `Buffer` are not available — which is exactly why the
// middleware used to settle for "a Bearer header is PRESENT" while the route
// decided whether it was VALID. Two readers of one credential, and the weaker one
// ran first: it minted a rate-limit bucket per PRESENTED token, so rotating an
// invented bearer bought a fresh quota on every request, and it charged the
// shared per-address bucket for requests that were about to 401, so credential-
// less traffic could spend the owner's quota and lock the owner out. Both are
// closed by letting the middleware ask this function the same question the route
// asks — which it can only do if this file runs in both runtimes.

export type Access = "read" | "write";

/** The token in an Authorization header, or null. Shared so the middleware's
 *  bucket key and the route's credential are the same bytes, not two regexes
 *  that agree today. */
export function parseBearer(authorization: string | null | undefined): string | null {
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
}

// Constant-time within the limits of the runtime: compare every byte and
// accumulate, so the loop cannot exit early on the first mismatch. Length is
// compared first and leaks, exactly as node's timingSafeEqual does (it throws on
// a length mismatch, so every caller of it leaks the same bit).
function safeEqual(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function matches(presented: string, expected: string | undefined): boolean {
  // Refuse trivially guessable tokens outright: a 4-character BRAIN_WRITE_TOKEN
  // should not be a working credential just because someone set one.
  if (!expected || expected.length < 16) return false;
  return safeEqual(presented, expected);
}

// Fail closed: no token, an unknown token, or an unconfigured server all yield
// null. A write token also grants read.
export function grantFor(
  authorization: string | null,
  env: Record<string, string | undefined> = process.env,
): Access | null {
  const token = parseBearer(authorization);
  if (!token) return null;
  if (matches(token, env.BRAIN_WRITE_TOKEN)) return "write";
  if (matches(token, env.BRAIN_READ_TOKEN)) return "read";
  return null;
}
