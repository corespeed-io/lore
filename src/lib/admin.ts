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
}

export function adminConfig(env: Env = process.env): AdminConfig {
  return {
    mode: env.ADMIN_MODE === "1" || env.ADMIN_MODE === "true",
    url: env.ADMIN_GBRAIN_URL ?? "",
    token: env.ADMIN_GBRAIN_TOKEN ?? "",
    allowInsecure: env.ADMIN_ALLOW_INSECURE === "1" || env.ADMIN_ALLOW_INSECURE === "true",
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
};

export class AdminNotAllowedError extends Error {}

const SECRET_KEY = /(secret|token|password|bootstrap|apikey|api_key|credential)/i;

// Defensively redact secret-ish fields so a backend that over-returns can't leak
// a token/secret to the browser. Applied to every admin response EXCEPT a
// create's one-time secret (which the UI surfaces once and masks).
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

// Server-only proxy to the gbrain admin API. Authenticates with the configured
// bootstrap token as a Bearer (the cookie/login exchange upstream's bundled SPA
// uses is same-origin only — see docs for the cross-origin contract).
export async function adminFetch(
  action: string,
  args: Record<string, unknown> = {},
  env: Env = process.env,
): Promise<unknown> {
  const ep = ADMIN_ENDPOINTS[action];
  if (!ep) throw new AdminNotAllowedError(`admin action '${action}' not allowed`);
  const a = adminConfig(env);
  const url = new URL(`/admin/api/${ep.path}`, a.url);
  if (ep.method === "GET") {
    for (const [k, v] of Object.entries(args)) if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method: ep.method,
    headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" },
    body: ep.method === "POST" ? JSON.stringify(args) : undefined,
  });
  if (!res.ok) throw new Error(`admin backend ${res.status}`);
  const data = await res.json();
  return ep.oneTimeSecret ? data : stripSecrets(data);
}
