// Compiler-enforced server-only: holds the admin bootstrap token and is the
// admin security boundary. Importing it from a Client Component is a build error.
import "server-only";
import { loadConfig } from "./config";

// ── Admin config (read here, NOT in the Edge-bundled config.ts) ──────────────
type Env = Record<string, string | undefined>;

export interface AdminConfig {
  mode: boolean;
  url: string; // upstream gbrain admin base, e.g. https://gbrain.example
  token: string; // admin bootstrap token (server-only)
  allowInsecure: boolean;
  calibrationHolder: string; // which take-holder's profile the dashboard shows
}

export function adminConfig(env: Env = process.env): AdminConfig {
  return {
    mode: env.ADMIN_MODE === "1" || env.ADMIN_MODE === "true",
    url: env.ADMIN_GBRAIN_URL ?? "",
    token: env.ADMIN_GBRAIN_TOKEN ?? "",
    allowInsecure: env.ADMIN_ALLOW_INSECURE === "1" || env.ADMIN_ALLOW_INSECURE === "true",
    // gbrain's admin API defaults the calibration holder to `garry` (its
    // personal-brain origin). This team brain holds its profile under `brain`
    // (the take-extractor default; there is no people/garry here), so the
    // dashboard would read an empty garry profile and show "Cold start".
    // Override via ADMIN_CALIBRATION_HOLDER.
    calibrationHolder: env.ADMIN_CALIBRATION_HOLDER ?? "brain",
  };
}

// Admin is OFF and FAIL-CLOSED by default. It turns on only with explicit env,
// and — when the viewer runs open (AUTH_MODE=none) — its own insecure opt-in.
export function adminEnabled(env: Env = process.env): { ok: boolean; reason?: string } {
  const a = adminConfig(env);
  if (!a.mode) return { ok: false, reason: "admin mode is off (set ADMIN_MODE=1)" };
  if (!a.url) return { ok: false, reason: "ADMIN_GBRAIN_URL is not set" };
  if (!a.token) return { ok: false, reason: "ADMIN_GBRAIN_TOKEN is not set" };
  if (loadConfig(env).authMode === "none" && !a.allowInsecure)
    return { ok: false, reason: "AUTH_MODE=none requires ADMIN_ALLOW_INSECURE=1 to enable admin" };
  return { ok: true };
}

// ── Admin endpoint allowlist (SEPARATE from READ_ONLY_TOOLS) ─────────────────
// Maps a Lore admin action → an upstream gbrain `/admin/api/*` endpoint. The
// route proxies ONLY these; no arbitrary passthrough. Mirrors upstream
// garrytan/gbrain admin/src/api.ts (master). No create-OAuth-client: upstream
// has no such endpoint (clients are registered via the gbrain CLI).
export interface AdminEndpoint {
  method: "GET" | "POST";
  path: string; // under /admin/api/
  destructive?: boolean; // UI must confirm
  oneTimeSecret?: boolean; // response carries a one-time secret → not stripped
}

export const ADMIN_ENDPOINTS: Readonly<Record<string, AdminEndpoint>> = {
  stats: { method: "GET", path: "stats" },
  health: { method: "GET", path: "health-indicators" },
  agents: { method: "GET", path: "agents" },
  requests: { method: "GET", path: "requests" },
  "api-keys": { method: "GET", path: "api-keys" },
  jobs: { method: "GET", path: "jobs/watch" },
  calibration: { method: "GET", path: "calibration/profile" },
  "create-api-key": { method: "POST", path: "api-keys", oneTimeSecret: true },
  "revoke-api-key": { method: "POST", path: "api-keys/revoke", destructive: true },
  "revoke-client": { method: "POST", path: "revoke-client", destructive: true },
  "update-client-ttl": { method: "POST", path: "update-client-ttl" },
  "sign-out-everywhere": { method: "POST", path: "sign-out-everywhere", destructive: true },
};

// Calibration charts are server-rendered SVG (text/plain), proxied separately
// from the JSON endpoints. Only these exact chart types may be requested — no
// arbitrary SVG passthrough.
export const ADMIN_CHART_TYPES: ReadonlySet<string> = new Set([
  "brier-trend",
  "pattern-statements",
  "domain-bars",
  "abandoned-threads",
]);

export class AdminNotAllowedError extends Error {}

// Redact secret-bearing fields by key name. Tuned to catch real secrets
// (client_secret, access/refresh tokens, api keys, passwords, bootstrap) without
// nuking benign aggregate fields like token_ttl / active_api_keys.
const SECRET_KEY =
  /(^secret$|_secret$|client_secret|^token$|_token$|access_token|refresh_token|password|bootstrap|credential|^api_?key$|_api_?key$|api_?key_secret|api_?key_token)/i;

// Defensively redact secret-ish fields so a backend that over-returns can't leak
// a token/secret to the browser. Applied to every admin response (one-time
// secrets are re-attached afterwards by redactAdminResponse — see below).
export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : stripSecrets(v);
    }
    return out;
  }
  return value;
}

// Shape an admin response for the browser. Always strip secret-ish fields; for a
// one-time-secret action (create-api-key) re-attach ONLY the `token` so it can be
// shown once. Re-attaching just `token` — instead of returning the raw object —
// means an over-returning backend can't smuggle a client_secret / refresh_token /
// bootstrap alongside it. Pure; exported for tests.
export function redactAdminResponse(data: unknown, oneTimeSecret: boolean): unknown {
  const redacted = stripSecrets(data);
  if (oneTimeSecret && data && typeof data === "object" && !Array.isArray(data)) {
    const token = (data as Record<string, unknown>).token;
    if (token != null && redacted && typeof redacted === "object")
      return { ...(redacted as Record<string, unknown>), token };
  }
  return redacted;
}

// CSRF defense for mutating admin POSTs. Require a JSON content-type (an HTML form
// can't send application/json, and a cross-origin JSON fetch needs a CORS preflight
// we never grant) AND a same-origin Origin header (browsers always send Origin on
// POST). Compares Origin's host to the Host header so it holds behind a proxy that
// forwards Host. Returns a rejection, or null when the request is allowed. Pure.
export function adminPostRejection(h: {
  contentType: string | null;
  origin: string | null;
  host: string | null;
}): { status: number; detail: string } | null {
  if (!(h.contentType ?? "").toLowerCase().startsWith("application/json"))
    return { status: 415, detail: "json required" };
  let sameOrigin = false;
  if (h.origin && h.host) {
    try {
      sameOrigin = new URL(h.origin).host === h.host;
    } catch {
      sameOrigin = false;
    }
  }
  if (!sameOrigin) return { status: 403, detail: "cross-site admin POST denied" };
  return null;
}

// gbrain's admin API authenticates with a session cookie minted by
// POST /admin/login {token: <bootstrap>} — NOT a Bearer. We log in server-side
// with the bootstrap token, cache the cookie, and re-auth on expiry. The
// bootstrap token never leaves the server, and the cookie is server-held too.
let adminCookie: { value: string; at: number } | null = null;
const COOKIE_TTL_MS = 45 * 60 * 1000;

async function adminLogin(a: AdminConfig): Promise<string> {
  const res = await fetch(new URL("/admin/login", a.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: a.token }),
  });
  if (!res.ok) throw new Error(`admin login ${res.status}`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("admin login returned no session cookie");
  adminCookie = { value: cookie, at: Date.now() };
  return cookie;
}

async function adminSession(a: AdminConfig): Promise<string> {
  if (adminCookie && Date.now() - adminCookie.at < COOKIE_TTL_MS) return adminCookie.value;
  return adminLogin(a);
}

// Server-only proxy to the gbrain admin API, authenticated by the login cookie.
export async function adminFetch(
  action: string,
  args: Record<string, unknown> = {},
  env: Env = process.env,
): Promise<unknown> {
  if (!adminEnabled(env).ok) throw new AdminNotAllowedError("admin is disabled");
  const ep = ADMIN_ENDPOINTS[action];
  if (!ep) throw new AdminNotAllowedError(`admin action '${action}' not allowed`);
  const a = adminConfig(env);
  const url = new URL(`/admin/api/${ep.path}`, a.url);
  if (ep.method === "GET") {
    for (const [k, v] of Object.entries(args)) if (v != null) url.searchParams.set(k, String(v));
    // Calibration profiles are per-holder; gbrain defaults to `garry`. Point it
    // at this brain's holder unless the caller already specified one.
    if (ep.path.startsWith("calibration/") && !url.searchParams.has("holder")) {
      url.searchParams.set("holder", a.calibrationHolder);
    }
  }
  const call = (cookie: string) =>
    fetch(url, {
      method: ep.method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: ep.method === "POST" ? JSON.stringify(args) : undefined,
    });
  let res = await call(await adminSession(a));
  if (res.status === 401) {
    adminCookie = null; // session expired → re-login once
    res = await call(await adminSession(a));
  }
  if (!res.ok) throw new Error(`admin backend ${res.status}`);
  const data = await res.json();
  return redactAdminResponse(data, Boolean(ep.oneTimeSecret));
}

// Proxy a calibration chart SVG (text/plain) — type-allowlisted, cookie-authed.
export async function adminFetchChart(type: string, env: Env = process.env): Promise<string> {
  if (!adminEnabled(env).ok) throw new AdminNotAllowedError("admin is disabled");
  if (!ADMIN_CHART_TYPES.has(type))
    throw new AdminNotAllowedError(`chart type '${type}' not allowed`);
  const a = adminConfig(env);
  const url = new URL(`/admin/api/calibration/charts/${encodeURIComponent(type)}`, a.url);
  // Same per-holder scoping as the profile endpoint (gbrain defaults to garry).
  url.searchParams.set("holder", a.calibrationHolder);
  const call = (cookie: string) => fetch(url, { headers: { Cookie: cookie } });
  let res = await call(await adminSession(a));
  if (res.status === 401) {
    adminCookie = null;
    res = await call(await adminSession(a));
  }
  if (!res.ok) throw new Error(`admin chart ${res.status}`);
  return res.text();
}
