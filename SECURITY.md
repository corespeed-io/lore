# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report privately via
GitHub: go to the repo's **Security** tab → **Report a vulnerability**
([new advisory](https://github.com/corespeed-io/lore/security/advisories/new)). We
aim to acknowledge within a few business days.

## Security model

Lore is a **read-only** viewer for a gbrain knowledge brain. A few invariants that
reviewers and contributors should preserve:

- **Read-only boundary.** `READ_ONLY_TOOLS` in `src/lib/gbrain.ts` is enforced
  server-side and is the security boundary. Never add a mutating tool to it, and
  never add a route that writes to gbrain.
- **Secrets are server-only.** `GBRAIN_TOKEN` is read only in server code (guarded
  by `server-only`) and is never sent to the browser. Never commit `.env`; use
  `.env.example` as the template.
- **Auth fails closed.** `AUTH_MODE=proxy` verifies the Cloudflare Access JWT
  (signature, audience, issuer, expiry). `AUTH_MODE=none` is honored only with
  `ALLOW_INSECURE=1`. A misconfigured proxy deployment denies rather than opening up.
- Responses don't leak upstream errors; the API routes are rate-limited; a strict
  Content-Security-Policy and standard security headers are set in `next.config.mjs`.

## Deploying safely

Never deploy with `AUTH_MODE=none` reachable from the internet. Put the app behind
Cloudflare Access (`AUTH_MODE=proxy`) or HTTP Basic (`AUTH_MODE=password`), and make
sure the origin is only reachable through that layer.
