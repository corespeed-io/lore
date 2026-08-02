// EDGE-RUNTIME MODULE. middleware.ts imports this, so this file and ./config run
// in the Edge runtime — use only Web APIs (atob, fetch, jose), never Node-only
// ones (Buffer, node:*, fs). A Node API pulled in here poisons the middleware
// bundle: it passes typecheck and breaks only at build/deploy.
import { createRemoteJWKSet, jwtVerify } from "jose";
import { type GatewayConfig, loadConfig } from "./config";

export interface AuthResult {
  ok: boolean;
  status?: number;
  wwwAuthenticate?: boolean;
  // Human-readable reason for a denial, so the client error names the real cause
  // (which auth mode / which env is missing) instead of a generic guess.
  detail?: string;
  // Who the gateway says this is, when it proved it. Nothing depends on it yet;
  // it is here so a future per-user surface reads an identity that was VERIFIED
  // rather than one it re-derives from a header.
  user?: string;
}

// One remote JWKS per URL; jose caches the keys behind it.
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(url: string) {
  let jwks = jwksByUrl.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksByUrl.set(url, jwks);
  }
  return jwks;
}

// Length-independent comparison. The UI password used `===`, which leaks its
// length and then its prefix to a patient caller — the brain tokens have had a
// constant-time compare since day one, and there was no reason for the two doors
// to disagree about that.
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkPassword(headers: Headers, password: string): AuthResult {
  const h = headers.get("authorization") ?? "";
  if (h.startsWith("Basic ")) {
    // atob, not Buffer — this runs on the Edge runtime (middleware).
    const decoded = atob(h.slice(6));
    if (secretEquals(decoded.slice(decoded.indexOf(":") + 1), password)) return { ok: true };
  }
  return { ok: false, status: 401, wwwAuthenticate: true, detail: "auth required" };
}

// The gateway proved nothing until it proves it came from the gateway. Order is
// deliberate: a configured JWKS is the stronger claim, so it decides alone — a
// deployment that sets both does not get to fall back to the weaker one when a
// token fails to verify.
async function checkGateway(headers: Headers, g: GatewayConfig): Promise<AuthResult> {
  const user = () => headers.get(g.userHeader.toLowerCase()) ?? undefined;

  if (g.jwksUrl) {
    if (!g.issuer || !g.audience)
      return {
        ok: false,
        status: 403,
        detail: "AUTH_GATEWAY_JWKS_URL is set but AUTH_GATEWAY_ISSUER/AUDIENCE are not",
      };
    const token =
      headers.get(g.jwtHeader.toLowerCase()) ??
      // Cloudflare Access also sets a cookie of the same token; middleware reads
      // headers only, so a deployment behind it must let the header through.
      "";
    if (!token) return { ok: false, status: 403, detail: `gateway token missing (${g.jwtHeader})` };
    try {
      const { payload } = await jwtVerify(token, jwksFor(g.jwksUrl), {
        issuer: g.issuer,
        audience: g.audience,
      });
      // The JWT's own subject IS the identity — it is signed, and the header
      // beside it is not. A verified token that carries no usable subject falls
      // back to NOTHING rather than to that header: silently preferring the
      // unsigned value is how a "verified" identity becomes attacker-chosen.
      const sub = typeof payload.email === "string" ? payload.email : payload.sub;
      return { ok: true, user: typeof sub === "string" ? sub : undefined };
    } catch {
      return { ok: false, status: 403, detail: "gateway token invalid" };
    }
  }

  if (g.sharedSecret) {
    const presented = headers.get(g.secretHeader.toLowerCase()) ?? "";
    if (!secretEquals(presented, g.sharedSecret))
      return { ok: false, status: 403, detail: "gateway secret missing or wrong" };
    return { ok: true, user: user() };
  }

  // Configured as gateway, but with no way to tell the gateway from anyone else.
  // Refuse rather than trust the identity header, which is the failure mode this
  // whole mode exists to avoid.
  return {
    ok: false,
    status: 403,
    detail:
      "AUTH_MODE=gateway needs a proof: set AUTH_GATEWAY_JWKS_URL (+ISSUER/+AUDIENCE) or AUTH_GATEWAY_SHARED_SECRET",
  };
}

export async function checkAuth(headers: Headers): Promise<AuthResult> {
  const cfg = loadConfig();

  if (cfg.authMode === "gateway") return checkGateway(headers, cfg.gateway);

  // A half-configured mode is a CONFIGURATION ERROR, not an invitation to serve
  // the brain unauthenticated. This used to fall through to `allowInsecure`, so
  // `AUTH_MODE=password` + a forgotten `UI_PASSWORD` + `ALLOW_INSECURE=1` (the
  // documented local-dev pair) silently opened the whole console — and, because
  // the admin gate keyed on the DECLARED mode rather than on whether auth
  // actually held, it opened admin with it.
  if (cfg.authMode === "password") {
    if (!cfg.uiPassword)
      return { ok: false, status: 403, detail: "AUTH_MODE=password but UI_PASSWORD is not set" };
    return checkPassword(headers, cfg.uiPassword);
  }

  if (cfg.allowInsecure) return { ok: true };
  return {
    ok: false,
    status: 403,
    detail:
      "auth not configured: set AUTH_MODE (gateway|password), or ALLOW_INSECURE=1 to run with no auth",
  };
}
