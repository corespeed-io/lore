# Withdrawn proposal: transition of existing OSS tenancy

Date: 2026-09-16. Status: **withdrawn; do not execute this transition**. The user
subsequently chose to retain existing OSS multi-tenancy and separate its business
rules from Core. The current direction is recorded in
[OSS memory-engine module boundaries](oss-memory-module-boundaries.md).
No removal, migration or deployment action was performed from this proposal.
The following records the earlier analysis only.

At the time of this proposal, the user agreed with a single-person/team OSS direction and asked how to
handle the existing multi-tenant implementation. They do not yet know whether
there are non-disposable OSS deployments with data to retain. Treat existing
data as valuable until an operator inventory establishes otherwise.

## Problem statement

Workspace is currently a real tenant boundary across storage, membership,
Agent grants, HTTP, both SDKs, CLI/MCP, browser state and portability. Removing
only the selector or substituting a default Workspace would conceal this model
without changing it, and could make existing data inaccessible or broaden access.

The desired product direction is an OSS deployment serving one person or team.
Memory ownership, private/shared visibility, credential revocation and Agent
provenance remain distinct capabilities. Moving tenant management into OSS is
not the target; an external multi-tenant product owns that business model.
Currently shared Memory grants read visibility, not universal write access:
the owner or an authorized write Agent acting for that owner still controls
writes. Preserve this distinction when changing the scope of team access.

## Solution

Separate the behavior-preserving Core refactor from the breaking OSS product
transition. Keep the current isolation effective while designing and verifying
its replacement. Do not add a permanent single-tenant/multi-tenant mode switch
or a third Lore tenancy package.

An inventory is required before selecting a data transition:

| Existing deployment | Proposed handling |
| --- | --- |
| Confirmed disposable development/test data | Rebuild only the confirmed disposable database, using the normal migration chain. |
| Data to retain, one Workspace | Use a forward migration preserving identities, ownership, permissions and record relationships. |
| Data to retain, multiple Workspaces | Prepare an explicit mapping to separate deployments and validate it before cutover; do not merge or silently select the first Workspace. |
| Unknown, including the current situation | Continue with read-only inventory and behavior-preserving refactoring; do not run a destructive conversion. |

Multiple Workspaces belonging to one team may still encode different readership
and Agent grants. Combining them is not the default migration: it requires an
explicit product decision and proof that private/shared visibility does not
expand. Separate target deployments are the conservative proposed mapping.

## Incremental implementation plan

These are reviewable commit/release boundaries. Each step must remain usable;
dependent product/API/schema changes ship together after preparation succeeds.

1. **Add a read-only deployment inventory.** Report migration revision, Workspace
   counts, domain row counts, membership/grant states and cross-reference
   coverage. Include durable evidence, identities and credentials without
   exposing content or secrets. Record whether the inventory represents an
   actual deployment or only a test fixture. This tool must not select a winner,
   merge rows, remove data or change permissions.
2. **Lock down the behavior that must survive.** Extend existing interface tests
   only where needed to cover private/shared reads, read-only and revoked Agents,
   mutations, retrieval evidence, links, proposals and evidence visibility. Keep
   current tenant-isolation fixtures during the refactor. Establish baseline
   outputs for representative retrieval queries.
3. **Decouple Core from product identity without changing deployed behavior.**
   Define and exercise the storage/transaction interface through both the
   existing host and a standalone single-domain consumer. Core retains Memory
   persistence, algorithms, indexing and consistency. Host-owned policy controls
   candidate visibility and writes in the same database transaction. Removing
   identity types alone is insufficient: public records, inserted columns,
   permission-function calls, role selection and identity-bound idempotency must
   also be audited. Do not declare Core independent while these assumptions
   remain. The exact interface needs design and tests before implementation.
4. **Prepare the selected data transition and run it against a restored copy.**
   Build only the transition required by the inventory. A multi-Workspace split
   needs a dedicated complete transfer path, not the existing user archive.
   Preserve authoritative content and durable evidence, map ownership and grants
   explicitly, account for shared identities/Agents, and define target credential
   provisioning. Rebuildable indexes can be regenerated, but citations and source
   evidence cannot be dropped. Define how jobs and replay records transfer, then
   validate counts, hashes, relationships and access results. Final cutover must
   quiesce writes/workers or provide an equally proven consistency mechanism.
5. **Deliver a coordinated breaking OSS contract.** Resolve the one deployment
   scope on the server; change HTTP/OpenAPI, both SDKs, CLI/MCP and browser state
   together. Remove Workspace creation/switching as a user prerequisite and
   tenant selection from the public request contract. Recast needed team access
   and Agent permissions as deployment-level capabilities. The installer creates
   the initial administrator; an additional authenticated user needs an explicit
   admission path into this deployment, not automatic access or a new hidden
   Workspace. Old selectors must
   never be silently accepted with a different meaning. Choose and document the
   breaking API/package release identifier during implementation; do not maintain
   a second permanent runtime mode. A single-domain release must refuse an
   unconverted multi-Workspace database before serving requests or running jobs.
6. **Complete schema and implementation cleanup.** Add forward-only migrations;
   never rewrite the applied baseline. Remove obsolete Workspace/Membership/grant
   structures only after their still-needed authorization semantics and every
   consumer have been replaced. Remove tenant-specific policies while preserving
   the selected user/privacy policies. Update schema-revision checks, operational
   receipts and tests in the same change. No placeholder global Workspace or
   renamed namespace should remain solely to simulate removed tenant behavior.
7. **Verify and cut over the chosen deployment.** Complete an isolated restore
   drill, deterministic migration checks and end-to-end tests before deploying.
   Define the last safe rollback point before allowing new writes. Do not claim
   that restoring an old snapshot after accepting new writes is lossless rollback.
   Retain the source backup under the operator's retention policy; source data
   cleanup is a separately authorized action.

Steps 1–3 can proceed without deciding to delete tenant data. Steps 4–7 require a
known deployment inventory and a concrete, reviewed transition. Keeping the old
release running until cutover is release sequencing, not a new supported dual
mode inside Lore.

## Data coverage constraints

The existing Workspace archive is explicitly Actor-visible and contains only
Memories and Links. It excludes other members' private Memories. Import assigns
fresh Memory IDs, writes them as the importing User and clears creating-Agent
identity. It is useful for user-level portability, not full-fidelity tenant
relocation. It does not carry the full identity/credential, Episode/Observation,
Proposal, Code Evidence, evaluation or maintenance state.

The repository already documents full PostgreSQL backup/restore. That can
preserve and rehearse an existing whole deployment. There is no verified
Workspace-by-Workspace full deployment splitter in the inspected code. Do not
promise a complete multi-Workspace transition using the current archive.

The current password/no-auth modes represent one local principal; separate human
identities currently come from verified proxy authentication. Keeping multi-user
privacy does not imply that a complete self-hosted invitation/user-management
product already exists. Expanding that product is a separate scope decision.

## Testing decisions

- Test actual read/write visibility through public interfaces, including provider
  inputs before reranking; retain adversarial ownership and Agent-grant cases.
- Verify the standalone Core consumer works without OSS identity/membership
  modules, while the current host keeps its previous access behavior.
- Exercise empty, one-Workspace and multiple-Workspace migration fixtures,
  including private evidence, shared Agents and revoked credentials. An unknown
  or unmapped multi-Workspace database must not be automatically converted.
- Compare canonical content, durable evidence, graph links and ownership mappings
  across migration; test referential integrity and complete table coverage, not
  only Memory row counts.
- Verify both SDKs, CLI/MCP and browser workflows against the same released HTTP
  contract. Test deliberate rejection of obsolete tenant selectors and correct
  readiness/schema checks. No model-protocol change is needed for this work.
- Verify a second admitted user joins the same deployment, retains independent
  private Memory/Agent ownership and cannot write another user's shared Memory;
  unaffiliated or disabled users must not gain access through simplified onboarding.

## Out of scope

Automatic HaaS changes (it retains an independent vendored fork), a new tenant
framework, generic multi-database support, automatic tenant merging, deleting
unknown deployments, a fresh identity provider, and a permanent compatibility
layer for both product models.

## Source evidence

- [Domain vocabulary](../../CONTEXT.md), [request context](../../src/server/auth/request-context.ts),
  [access implementation](../../src/server/auth/access.ts).
- [Archive and import behavior](../../src/modules/portability/service.ts),
  [portability behavior tests](../../tests/integration/portable-core.test.ts).
- [Backup and restore guide](../operations.md#logical-backup-and-restore-drill),
  [migration history validation](../../scripts/database/lib/migration-preflight.mjs).
- [Browser shell](../../src/shell/App.tsx), [CLI](../../packages/cli/src/index.ts),
  [MCP](../../packages/mcp/src/index.ts), [authentication](../../src/server/auth/auth.ts).
- [OSS source comparison and target scope](oss-memory-module-boundaries.md).
