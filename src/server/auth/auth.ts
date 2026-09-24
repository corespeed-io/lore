// EDGE-RUNTIME MODULE. middleware.ts imports this, so this file and ./config run
// in the Edge runtime — use only Web APIs (atob, fetch, jose), never Node-only
// ones (Buffer, node:*, fs). A Node API pulled in here poisons the middleware
// bundle: it passes typecheck and breaks only at build/deploy.
import { parse as parseCookies } from "hono/utils/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { loadConfig } from "@/server/config";

export interface AuthResult {
  ok: boolean;
  status?: number;
  wwwAuthenticate?: boolean;
  // Human-readable reason for a denial, so the client error names the real cause
  // (which auth mode / which env is missing) instead of a generic guess.
  detail?: string;
  principal?: AuthPrincipal;
}

export interface AuthPrincipal {
  provider: string;
  subject: string;
  displayName: string;
  email?: string;
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

async function passwordMatches(candidate: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const candidateBytes = new Uint8Array(candidateHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < candidateBytes.length; index += 1) {
    difference |= candidateBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

async function checkPassword(
  headers: Headers,
  password: string,
  principal: AuthPrincipal,
): Promise<AuthResult> {
  const h = headers.get("authorization") ?? "";
  if (h.startsWith("Basic ")) {
    // atob, not Buffer — this runs on the Edge runtime (middleware).
    let decoded: string;
    try {
      decoded = atob(h.slice(6));
    } catch {
      return { ok: false, status: 401, wwwAuthenticate: true, detail: "auth required" };
    }
    const separator = decoded.indexOf(":");
    const username = separator >= 0 ? decoded.slice(0, separator).trim() : "";
    if (username && (await passwordMatches(decoded.slice(separator + 1), password))) {
      // Password mode is a single-operator self-hosting mode. The caller-supplied
      // Basic username is deliberately not an identity selector: otherwise anyone
      // who knows the shared password could impersonate another internal User.
      return { ok: true, principal };
    }
  }
  return { ok: false, status: 401, wwwAuthenticate: true, detail: "auth required" };
}

export async function checkAuth(headers: Headers): Promise<AuthResult> {
  const cfg = loadConfig();

  if (cfg.authMode === "proxy") {
    // Fail closed if proxy mode was selected but not fully wired.
    if (!cfg.accessAud || !cfg.accessTeamDomain)
      return {
        ok: false,
        status: 403,
        detail: "AUTH_MODE=proxy but ACCESS_AUD/ACCESS_TEAM_DOMAIN are not set",
      };
    const token =
      headers.get("cf-access-jwt-assertion") ||
      parseCookies(headers.get("cookie") ?? "", "CF_Authorization").CF_Authorization;
    if (!token) return { ok: false, status: 403, detail: "Cloudflare Access required" };
    try {
      // Real verification: signature against Cloudflare's JWKS, plus issuer,
      // audience (ACCESS_AUD), and exp/nbf. A forged/expired/wrong-app token fails.
      const { payload } = await jwtVerify(token, jwksFor(cfg.accessTeamDomain), {
        issuer: `https://${cfg.accessTeamDomain}`,
        audience: cfg.accessAud,
      });
      if (!payload.sub)
        return { ok: false, status: 403, detail: "Cloudflare Access subject missing" };
      const email = typeof payload.email === "string" ? payload.email : undefined;
      return {
        ok: true,
        principal: {
          provider: `cloudflare-access:${cfg.accessTeamDomain}`,
          subject: payload.sub,
          displayName: email ?? payload.sub,
          email,
        },
      };
    } catch {
      return { ok: false, status: 403, detail: "Cloudflare Access token invalid" };
    }
  }

  if (cfg.authMode === "password") {
    if (!cfg.uiPassword) {
      return {
        ok: false,
        status: 403,
        detail: "AUTH_MODE=password but UI_PASSWORD is not set",
      };
    }
    return checkPassword(headers, cfg.uiPassword, {
      provider: "local",
      subject: cfg.localSubject,
      displayName: cfg.localDisplayName,
      email: cfg.localEmail || undefined,
    });
  }

  if (cfg.authMode === "invalid") {
    return {
      ok: false,
      status: 403,
      detail: "AUTH_MODE must be one of: none, password, proxy",
    };
  }

  // Only explicit no-auth mode may use the local-development escape hatch.
  // A configured auth mode must never degrade to anonymous access because one
  // of its required secrets is missing.
  if (cfg.authMode === "none" && cfg.allowInsecure) {
    return {
      ok: true,
      principal: {
        provider: "local",
        subject: cfg.localSubject,
        displayName: cfg.localDisplayName,
        email: cfg.localEmail || undefined,
      },
    };
  }
  return {
    ok: false,
    status: 403,
    detail:
      "auth not configured: set AUTH_MODE (proxy|password), or ALLOW_INSECURE=1 to run with no auth",
  };
}

const OPERATIONAL_PROBE_PATHS = new Set(["/api/health", "/livez", "/readyz"]);

export function isOperationalProbePath(path: string): boolean {
  return OPERATIONAL_PROBE_PATHS.has(path);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The request's own host names: its URL, Host, and a proxy's first X-Forwarded-Host. */
function requestHosts(request: Request): Set<string> {
  const hosts = new Set([new URL(request.url).host.toLowerCase()]);
  for (const name of ["host", "x-forwarded-host"]) {
    const value = request.headers.get(name)?.split(",")[0]?.trim().toLowerCase();
    if (value) hosts.add(value);
  }
  return hosts;
}

/**
 * Browser CSRF defense for unsafe methods. A cross-site Fetch Metadata request, or one
 * whose Origin is not this request's own host, is rejected before authentication, so
 * ambient Basic credentials or an Access cookie cannot be replayed by another site.
 * Non-browser clients (SDK, CLI, MCP) send neither header and are unaffected. Hosts
 * compare without the scheme: a TLS-terminating proxy may present plain HTTP here.
 */
export function isCrossSiteRequest(request: Request): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  if (request.headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  let originHost: string;
  try {
    // An opaque "null" Origin (sandboxed frame, privacy redirect) is never this host.
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }
  return !originHost || !requestHosts(request).has(originHost);
}

function denial(status: number, detail: string | undefined, wwwAuthenticate = false): Response {
  return Response.json(
    {
      code: status === 401 ? "authentication_required" : "access_denied",
      error: detail ?? (status === 401 ? "auth required" : "forbidden"),
    },
    {
      status,
      headers: {
        "cache-control": "private, no-store",
        ...(wwwAuthenticate ? { "www-authenticate": "Basic" } : {}),
      },
    },
  );
}

export interface Admission {
  /** Present when the request must be answered with this response instead. */
  denied?: Response;
  /** The verified human principal, so handlers do not verify the credential again. */
  principal?: AuthPrincipal;
}

/** Shared admission policy. Domain handlers still authorize the Actor and enforce RLS. */
export async function admitRequest(request: Request): Promise<Admission> {
  const path = new URL(request.url).pathname;
  if (isOperationalProbePath(path)) return {};
  if (isCrossSiteRequest(request)) return { denied: denial(403, "Cross-site request rejected") };
  const authorization = request.headers.get("authorization") ?? "";
  if (path.startsWith("/api/") && /^Bearer lore_agent_[0-9a-f]{64}$/.test(authorization)) {
    return {};
  }
  const result = await checkAuth(request.headers);
  if (result.ok) return { principal: result.principal };
  return { denied: denial(result.status ?? 403, result.detail, result.wwwAuthenticate) };
}

/** Admission for callers that only need the denial, such as Next middleware. */
export async function authorizeRequest(request: Request): Promise<Response | undefined> {
  return (await admitRequest(request)).denied;
}
