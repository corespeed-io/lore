# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report privately via
GitHub: go to the repo's **Security** tab → **Report a vulnerability**
([new advisory](https://github.com/corespeed-io/lore/security/advisories/new)). We
aim to acknowledge within a few business days.

## Security model

Lore is a multi-tenant Memory system. Its Postgres/RLS persistence layer is active;
reviewers and contributors must preserve these invariants:

- **Database-enforced isolation.** Postgres RLS must protect every tenant-owned
  table. Workspace and private-scope filters are applied before retrieval ranking.
- **Authentication is not authorization.** Provider claims resolve an internal
  User; Memberships and Agent Workspace grants determine access.
- **Secrets are server-only.** Agent credentials, provider keys, and database
  credentials never reach the browser. Never commit `.env`; use `.env.example` as
  the template.
- **Auth fails closed.** `AUTH_MODE=proxy` verifies the Cloudflare Access JWT
  (signature, audience, issuer, expiry). `AUTH_MODE=none` is honored only with
  `ALLOW_INSECURE=1`. A misconfigured proxy deployment denies rather than opening up.
- **Derived data follows the source.** Deletion and scope changes invalidate
  chunks, embeddings, caches, and graph data without revealing private neighbors.
- **Cloud database reads are never edge-cached.** The Hyperdrive configuration must
  use `--caching-disabled`; RLS and revocation checks depend on fresh,
  transaction-local context.
- A strict Content-Security-Policy and standard security headers are set in
  `next.config.mjs`.

## Deploying safely

Never deploy with `AUTH_MODE=none` reachable from the internet. CoreSpeed Cloud uses
Cloudflare Access (`AUTH_MODE=proxy`). HTTP Basic is temporary protection for a
self-hosted single-operator instance, not a substitute for the internal User/Identity
model. An accepted Basic login always resolves to `LORE_LOCAL_SUBJECT`; the supplied
username does not choose an internal User.
