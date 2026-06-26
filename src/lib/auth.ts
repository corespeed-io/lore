// EDGE-RUNTIME MODULE. middleware.ts imports this, so this file and ./config run
// in the Edge runtime — use only Web APIs (atob, fetch, jose), never Node-only
// ones (Buffer, node:*, fs). A Node API pulled in here poisons the middleware
// bundle: it passes typecheck and breaks only at build/deploy.
import { createRemoteJWKSet, jwtVerify } from "jose";
import { loadConfig } from "./config";

export interface AuthResult {
  ok: boolean;
  status?: number;
  wwwAuthenticate?: boolean;
  // Human-readable reason for a denial, so the client error names the real cause
  // (which auth mode / which env is missing) instead of a generic guess.
  detail?: string;
}

// One remote JWKS per Cloudflare Access team domain; jose caches the keys.
const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(teamDomain: string) {
  let jwks = jwksByTeam.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeam.set(teamDomain, jwks);
  }
  return jwks;
}

function checkPassword(headers: Headers, password: string): AuthResult {
  const h = headers.get("authorization") ?? "";
  if (h.startsWith("Basic ")) {
    // atob, not Buffer — this runs on the Edge runtime (middleware).
    const decoded = atob(h.slice(6));
    if (decoded.slice(decoded.indexOf(":") + 1) === password) return { ok: true };
  }
  return { ok: false, status: 401, wwwAuthenticate: true, detail: "auth required" };
}

export async function checkAuth(
  headers: Headers,
  cookies: { get(n: string): { value: string } | undefined },
): Promise<AuthResult> {
  const cfg = loadConfig();

  if (cfg.authMode === "proxy") {
    // Fail closed if proxy mode was selected but not fully wired.
    if (!cfg.accessAud || !cfg.accessTeamDomain)
      return {
        ok: false,
        status: 403,
        detail: "AUTH_MODE=proxy but ACCESS_AUD/ACCESS_TEAM_DOMAIN are not set",
      };
    const token = headers.get("cf-access-jwt-assertion") || cookies.get("CF_Authorization")?.value;
    if (!token) return { ok: false, status: 403, detail: "Cloudflare Access required" };
    try {
      // Real verification: signature against Cloudflare's JWKS, plus issuer,
      // audience (ACCESS_AUD), and exp/nbf. A forged/expired/wrong-app token fails.
      await jwtVerify(token, jwksFor(cfg.accessTeamDomain), {
        issuer: `https://${cfg.accessTeamDomain}`,
        audience: cfg.accessAud,
      });
      return { ok: true };
    } catch {
      return { ok: false, status: 403, detail: "Cloudflare Access token invalid" };
    }
  }

  if (cfg.authMode === "password" && cfg.uiPassword) {
    return checkPassword(headers, cfg.uiPassword);
  }

  // "none", or password mode with no UI_PASSWORD set: fail closed unless the
  // operator explicitly opted into insecure mode.
  if (cfg.allowInsecure) return { ok: true };
  const detail =
    cfg.authMode === "password"
      ? "AUTH_MODE=password but UI_PASSWORD is not set"
      : "auth not configured: set AUTH_MODE (proxy|password), or ALLOW_INSECURE=1 to run with no auth";
  return { ok: false, status: 403, detail };
}
