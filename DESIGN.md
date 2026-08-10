# Design system — Lore

> Status: Active
> Canonical source: `DESIGN.md`
> Last decision review: 2026-08-10

This document is Lore's binding UI contract. Lore is a native Memory System;
the product model in `CONTEXT.md` defines every frontend data contract.

## 1. Source of truth

- Canonical frontend: `src/app` and `src/components`
- Application stylesheet: `src/app/globals.css`
- Feature owner: `src/components/App.tsx`
- Shell owner: `src/components/Sidebar.tsx`
- Native browser API: `src/lib/lore-api.ts`
- No second stylesheet or compatibility data model is authoritative.

## 2. Product principles

### Primary job

People open Lore to capture, find, inspect, and control durable Memory that they
and their permitted Agents can use inside one Workspace boundary.

### Navigation model

The persistent Lore shell selects a Workspace, exposes global Memory search, and
navigates between product capabilities. The content surface owns the selected
workflow and its detail layer.

### Information density

Use rows for Memory collections, a focused detail view for inspection, and compact
panels for editing or creation. The Dashboard uses dense operational panels;
retrieval remains a full-width browse/search surface.

### Semantic distinctions

- Capability appears in navigation; unavailable capability says `soon`.
- Activity appears as dates and result counts, not decorative status color.
- Scope is explicit text (`shared` or `private`) on every Memory row and detail.
- Ownership and provenance live in the detail context, not the browse hierarchy.
- Database and RLS health are quiet shell context, not a success banner.

### Responsive completeness

Workspace selection, search, Memory browse, Graph exploration, create, inspect,
edit, scope change, forget, Agent management, Proposal review, and Workspace
portability must all remain complete on mobile. The sidebar becomes a drawer; the
product model does not change.

## 3. Information architecture

| Destination | User job | Primary content | Attention behavior |
|---|---|---|---|
| Dashboard | Understand the active Workspace | Activity, types, hubs, sources, API health | Unknown graph state is never rendered as zero |
| Memories | Capture and retrieve Memory | Searchable chronological rows | Errors render inline near the workflow |
| Graph | Explore authorized Memory relationships | Interactive affinity map + selection inspector | Errors remain inside the Graph workspace |
| Agents | Connect user-owned Agents to the active Workspace | Agent creation, grants, and credential lifecycle | Secrets are one-time; restore/revoke consequences stay explicit |
| Proposals | Review Agent-suggested Memory changes | Owner-private create/update proposals and evidence | Nothing enters searchable Memory before explicit human acceptance |
| Operations | Move visible Memory and inspect deployment health | Export/import workflow, readiness, and capabilities | Dry-run gates imports; degraded is distinct from unready |

Search is global to the active Workspace and always returns to Memories. Selecting
a Memory replaces the list with a detail workspace; Back returns to the same query.

| Layer | Appropriate content | Inappropriate content |
|---|---|---|
| Main workspace | Browse, ranked recall, editing | Global configuration |
| Context column | Scope, owner, provenance, timestamps | Primary content editing |
| Popover | Workspace selection | Long forms |
| Modal/panel | New Memory, destructive confirmation | Persistent navigation |

## 4. App shell and layout

### Desktop

The shell is a 224px sticky sidebar plus a fluid main region. Main content is
centered at 1100px; Memory detail may expand to 1280px. The document owns main
scrolling and the sidebar remains viewport-height.

### Responsive transformations

| Condition | Transformation |
|---|---|
| `<= 900px` | Sidebar becomes an off-canvas drawer with a 56px top bar |
| `<= 720px` | Main padding tightens and list metadata collapses without removing actions |
| `<= 560px` | Detail context stacks below content and composer actions wrap |

## 5. Color

| Token | Value | Role |
|---|---:|---|
| `--canvas` | `#fafafa` | App background and sidebar |
| `--surface` | `#ffffff` | Inputs, selected rows, panels |
| `--ink` | `#171717` | Primary text and primary actions |
| `--body` | `#4d4d4d` | Body text |
| `--mute` | `#8f8f8f` | Secondary text |
| `--faint` | `#a1a1a1` | Tertiary metadata |
| `--hairline` | `#ebebeb` | Structural borders |
| `--hairline-soft` | `#f2f2f2` | Hover and selected navigation |
| `--link` | `#0070f3` | Focus, links, active semantic accents |
| `--danger` | `#c9352b` | Destructive actions only |
| `--status-degraded-border` | `#ead7a4` | Degraded-status border |
| `--status-degraded-surface` | `#fffaf0` | Degraded-status surface |
| `--status-degraded-ink` | `#8a5a00` | Degraded-status text |

Hover uses `--hairline-soft`; selected states combine it with `--ink`; focus uses
a two-pixel `--link` ring. Color is scarce and never substitutes for labels.

## 6. Typography

- Families: Geist Sans and Geist Mono from `next/font`.
- Body: 14px / 1.45 / 400.
- Navigation and controls: 13–14px / 500.
- Labels and technical metadata: 10–12px Geist Mono.
- Headings: Geist Sans, 600, tight tracking.
- Minimum production text size: 10px for secondary technical metadata; 12px for actions.

## 7. Spacing, radius, shadow, and motion

- Registered spacing: 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40, 48, 64px.
- Compact controls: 6px radius; selected rows/cards: 8px; panels: 12px; hero: 16px.
- Shadows are limited to the mobile drawer, dialog, and floating detail panel.
- Motion uses 120–200ms ease-out for view entry and drawer transitions.
- `prefers-reduced-motion` removes non-essential motion.

## 8. Iconography

- Navigation and graph controls use local 15–16px outline SVG markup.
- Data visualizations may own semantic SVG markup; they do not become icon sources.
- Use 1.5px strokes, round caps where appropriate, and `currentColor`.
- Decorative icons are `aria-hidden`; icon-only controls require an accessible name.
- `public/lore-mark.svg` is the product mark and may not be recolored decoratively.

## 9. Component language and ownership

- `globals.css` owns tokens, reset, base rules, and documented component classes.
- `App.tsx` owns Workspace selection, native data, routing, mutations, and workflow composition.
- `GraphView.tsx` owns Graph filtering, selection, and inspection.
- `AgentsView.tsx` owns Workspace-scoped Agent creation, grant lifecycle, credential
  metadata, one-time credential reveal, credential revocation, and global Agent
  rename/status/deletion controls.
- `MemoryProposalsView.tsx` owns the human review inbox, evidence navigation,
  version-conflict state, and explicit proposal acceptance or rejection.
- `WorkspaceOperationsView.tsx` owns actor-visible archive download, checksum-backed
  dry-run/import, owner remap, and read-only deployment readiness/capabilities.
- `WorkerCanvasGraph.tsx` and `graph-canvas.worker.ts` own the production Graph's
  Worker-based D3 layout, Canvas paint, progressive reveal, elastic node drag,
  label collision, and zoom/pan state. `src/lib/viz/graph.ts` retains the shared
  instance contract and the legacy SVG benchmark control.
- `Sidebar.tsx` owns shell navigation, Workspace selection, mobile drawer, and search.
- Route files only load runtime configuration and render the feature boundary.

| Role | Component | Required states |
|---|---|---|
| Shell | `Sidebar` | desktop, mobile closed/open, Workspace-selected |
| Memory row | feature row | rest, hover, selected via detail, scope, search evidence |
| Composer | feature panel | empty, ready, saving, error |
| Detail | feature workspace | view/edit, saving, destructive, mobile stack |
| Graph | `GraphView` | loading, empty, mapped, filtered, selected, error |
| Agent management | `AgentsView` | loading, empty, create, active/revoked/disabled, credential reveal, lifecycle dialog, destructive confirmation, error |
| Proposal review | `MemoryProposalsView` | loading, empty, pending, selected, stale target, accepted/rejected receipt, error |
| Workspace operations | `WorkspaceOperationsView` | loading, ready/degraded/unready, export, file selected, dry-run, importing, receipt, error |

## 10. Workflow specifications

### Memory browse and recall

- Entry: Memories navigation or Workspace search.
- Default: newest visible Memories with scope and UTC update date.
- Search: 220ms debounce; results retain server ranking and show evidence.
- Empty states distinguish an empty Workspace from an empty query.
- Selecting a row opens a full detail workspace and preserves the list/query state.

### Capture Memory

- Entry: `New memory` in the persistent sidebar.
- Default scope: shared; private requires explicit selection.
- Saving disables duplicate submission and closes only after success.
- On mobile the composer is full-width and all actions remain reachable.

### Workspace selection

- The active Workspace is visible in the sidebar and persisted locally.
- Creating a Workspace is available from the selector, including first-run onboarding.
- Changing Workspace closes detail state and reloads visible Memory under new RLS context.

### Explore Memory Graph

- Entry: Graph navigation in the active Workspace.
- Nodes are only Memories returned by the Actor-specific native Graph API.
- Affinity links are derived from the current authorized node set and never name a hidden endpoint.
- Search dims non-matches; selection keeps the chosen Memory and its neighbors prominent.
- The graph supports free node drag, background pan, wheel/buttons zoom, fit-to-view,
  hover focus, and empty-canvas/Escape deselection.
- Default nodes stay unlabeled so the field remains readable at ~1,000 nodes. Labels
  appear for hover, selection, and active search/type/focus filters; node size and
  motion express centrality without persistent degree or hub annotations.
- Workspace navigation and responsive resizing preserve the actor's current zoom/pan.
  A graph-data refresh returns to the centered settling state until the new layout
  is ready.
- `Open Memory` enters the standard detail workspace; Back returns to Graph.
- Scope uses the graph palette plus explicit text in the inspector and legend, never
  color alone.

### Manage Agents

- Entry: Agents navigation in the active Workspace; management requires a human Actor.
- Creating an Agent also creates its initial read or write grant in that Workspace.
- Grant permission changes, revocation, and restoration remain separate from the
  Agent's global status. Restoring a grant explicitly warns that an active Agent's
  unrevoked credentials can authenticate in that Workspace again; credentials for
  a disabled Agent remain blocked until that Agent is re-enabled.
- Credential metadata may be revisited, but a new secret is shown exactly once and
  Lore retains only its prefix and hash. Revocation is explicit and irreversible.
- Disabled Agents remain visible for diagnosis but cannot authenticate or receive a
  new credential. Rename and status changes are global across the User-owned Agent's
  Workspace grants. Re-enabling may restore unrevoked credentials only where grants
  are active. Permanent deletion requires the Agent to be disabled plus an exact-name
  confirmation; it removes grants and credentials while retaining Memories and
  clearing their creating-Agent reference.

### Operate a Workspace

- Entry: Operations navigation in the active Workspace; export and import require a
  human Actor and remain scoped by the ordinary Workspace request context and RLS.
- Export downloads a checksummed, actor-visible logical archive. The interface names
  excluded data explicitly and never presents the archive as a PostgreSQL backup.
- Import begins with a bounded local file check, requires an explicit target-owner
  remap to the human returned by `/api/v1/actor` and a collision policy, then requires
  a successful server dry-run before the write action becomes available. An archive
  identity is never trusted as the target. Any changed input invalidates the dry-run
  receipt.
- The completed receipt reports imported/skipped counts and replay status without
  echoing Memory content. Successful import revalidates Memory, search, and Graph data.
- Readiness distinguishes `ready`, lexical-safe `degraded`, and request-blocking
  `unready`. Capabilities and the active embedding generation are read-only
  deployment facts, never Workspace/User/Agent settings.

### Review Memory Proposals

- Entry: Proposals navigation in the active Workspace; listing and review require a
  human Actor. Pending proposal content is owner-private and never appears in Memory
  browse, search, Graph, export, or outbox before acceptance.
- The inbox identifies create versus update, proposed scope, submitting human or
  Agent, evidence Memories, and the exact base Memory version for an update.
- An owner may have at most 100 pending proposals in one Workspace. New submission
  is refused until review frees an inbox slot, so no pending proposal becomes
  unreachable behind the native list bound.
- Selecting a proposal exposes its complete proposed content and metadata before
  actions. Canonical Memory evidence opens through the standard authorized Memory
  detail workflow. Raw Observation evidence is shown inline with kind, full
  currently visible content, and SHA-256; loading, request-failed, and
  unavailable-or-forgotten states remain distinguishable. Observation evidence is durable until
  its Episode is explicitly forgotten and does not become searchable Memory merely
  by appearing in review.
- Accept creates or updates canonical Memory exactly once. An update whose target
  version changed remains pending, disables acceptance, and explains the conflict;
  it is never silently rebased. Reject is explicit and irreversible but does not
  alter canonical Memory.
- Up to the latest 100 accepted and rejected proposals remain available in each
  recent-history view for 30 days. Pending proposals also expire after 30 days;
  forgetting a target or accepted Memory removes associated proposal content
  immediately. Successful acceptance updates Memory browse and revalidates search
  and Graph state without turning Proposal into a searchable Memory type.

## 11. Loading, empty, error, and attention states

- Initial loading uses the plain `Opening Lore…` status.
- Empty collection invites the first Memory; empty search suggests changing the phrase.
- Recoverable request errors appear inline with a Dismiss action and `role=alert`.
- Disabled actions remain readable and do not use spinners as their only label.

## 12. Accessibility and interaction requirements

- Use `aside`, `nav`, `main`, headings, labels, fieldsets, and live regions correctly.
- All controls are keyboard reachable with a visible focus ring.
- Escape closes the mobile drawer and composer/detail overlays when applicable.
- The one-time credential reveal is the exception: Escape and backdrop dismissal are
  blocked because closing would destroy the only secret display. It closes only after
  the human explicitly confirms that the token was saved.
- Touch targets are at least 34px; primary actions are at least 38px.
- No behavior depends only on hover or color.

## 13. Anti-patterns

- Components consume native `Workspace`, `Memory`, `MemorySearchResult`, and
  `MemoryGraph` contracts. Do not introduce tool-shaped compatibility models,
  proxy calls, page/slug models, or generic upstream passthroughs.
- Do not create a second visual track beside the restored Lore shell.
- Do not use giant editorial headlines, pill-heavy ledgers, or colored scope decoration.
- Do not expose embedding model selection in product UI; it is deployment configuration.
- Do not add feature-local stylesheets or third-party default UI. Inline styles
  are limited to dynamic visualization geometry/color/meter values and the
  persistent Graph mount visibility optimization.

## 14. Enforcement and maintenance

- Guard command: `bun run design:check`
- CI runs the design guard before typecheck.
- The guard owns the single stylesheet topology, required tokens and paths, and
  forbidden retired class names.
- Approved exception: native form controls remain in feature composition when they
  are unique to a workflow and use canonical global classes.
- Review this contract whenever navigation, workflow ownership, or design tokens change.

## 15. Decisions log

| Date | Decision | Reason | Supersedes |
|---|---|---|---|
| 2026-08-10 | Promote the measured Worker + Canvas renderer to the native Graph and keep labels interaction-driven | Keep ~1,000-node layout and drag responsive while making centrality visible without persistent annotation clutter | Main-thread SVG production renderer and always-on labels |
| 2026-08-09 | Add Operations as the human-only Workspace portability and deployment-health destination | Keep high-consequence export/import behind checksum validation, owner remap, and dry-run while making lexical-safe degradation visible | CLI/API-only Workspace portability |
| 2026-08-10 | Add Proposals as the human approval boundary for Agent-suggested Memory changes | Enable opt-in automated reasoning without allowing model output to silently become canonical Memory | Direct model-authored canonical writes as an evolution workflow |
| 2026-08-08 | Add Agents as a standard Lore destination on the canonical 1100px content track | Make human-only Agent creation, Workspace grants, and credential lifecycle a first-class native workflow without creating a second visual system | Agent administration without a binding UI contract |
| 2026-08-05 | Restore Lore's complete Dashboard/Graph/Memories shell and optimized graph interaction around native Memory types | Preserve the product's mature interface without importing an external domain model | The temporary simplified Memory console |
| 2026-08-06 | Fix Lore v1 at 1024 dimensions while allowing one provider/model per deployment | Self-host operators retain model choice without turning the database vector protocol into runtime configuration | Workspace/User model selection |
| 2026-08-05 | Build Graph as an Actor-specific Memory-affinity read model | Preserve exploration without weakening RLS or reviving the deleted proxy | Deferred Graph placeholder |
