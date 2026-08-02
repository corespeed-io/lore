# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report privately via
GitHub: go to the repo's **Security** tab → **Report a vulnerability**
([new advisory](https://github.com/corespeed-io/lore/security/advisories/new)). We
aim to acknowledge within a few business days.

## Security model

Lore is a public repo that serves a private brain. It is **not** a read-only app:
it stores its own pages and memories in Postgres, and agents write to it. The
protection is not "nothing writes" — it is that **reading and writing are separate
doors with separate credentials**, and the console only ever holds the reading one.

### Two doors

- **The console** (`/api/call`, used by the browser) is gated by the viewer auth
  below and passes `"read"` into the tool dispatcher. `handleRpc` decides from the
  tool's own declared `access`, so a write tool is unreachable from a viewer
  session no matter what the browser asks for. There is deliberately no second
  hand-written allowlist to drift out of step with the registry.
- **Agents** (`POST /api/mcp`, `/import`, `/api/maintenance`, `/api/export`) present
  a bearer: `BRAIN_WRITE_TOKEN` (read + write) or `BRAIN_READ_TOKEN` (read only).
  Both are ≥16 characters or refused outright, and compared in constant time.
  `/api/export` requires the **write** token even though it only reads — a full dump
  bypasses the read surface's filter, so the read credential is not enough for it.

### Invariants to preserve

- **A tool's `access` is the boundary.** Never widen a tool from `write` to `read`
  to make a console feature convenient; add the feature to the agent surface instead.
- **Secrets are server-only.** `BRAIN_*_TOKEN` is read only in server code (guarded
  by `import "server-only"`) and never reaches the browser. Never commit `.env`.
- **Auth fails closed, and a half-configured mode is an error rather than an
  opening.** `AUTH_MODE=password` with no `UI_PASSWORD` is refused — it does *not*
  fall through to `ALLOW_INSECURE`. `AUTH_MODE=none` is honored only with an
  explicit `ALLOW_INSECURE=1`.
- **`AUTH_MODE=gateway` never trusts an identity header on its own.** The
  `X-Forwarded-User` header is read only after the gateway has proved it is the
  gateway — a JWT verified against `AUTH_GATEWAY_JWKS_URL` (signature, issuer,
  audience, expiry), or `AUTH_GATEWAY_SHARED_SECRET` compared in constant time.
  With neither configured, gateway mode refuses every request. Do not add a
  "trust the header" option.
- **Credentials must not enter the brain.** Every argument of every write tool is
  screened for secrets before any handler runs, and every write tool refuses to
  name a page in the reserved `memory/` namespace.
- Responses don't leak upstream errors; the API routes are rate-limited; a strict
  Content-Security-Policy and standard security headers are set in `next.config.mjs`.

## Deploying safely

Never deploy with `ALLOW_INSECURE=1` reachable from the internet — it serves the
whole brain to anyone. Pick `AUTH_MODE=gateway` (behind Cloudflare Access,
oauth2-proxy, Authelia, or any proxy that can sign a JWT or set a secret header)
or `AUTH_MODE=password`, and make sure the origin is only reachable through that
layer. Treat `BRAIN_WRITE_TOKEN` as production-grade: it can write, delete, import
and export the entire brain.
