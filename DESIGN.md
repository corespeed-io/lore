# Design system — Lore

> Status: Active
> Canonical source: `DESIGN.md`
> Last decision review: 2026-08-05

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
edit, scope change, and forget must all remain complete on mobile. The sidebar
becomes a drawer; the product model does not change.

## 3. Information architecture

| Destination | User job | Primary content | Attention behavior |
|---|---|---|---|
| Dashboard | Understand the active Workspace | Activity, types, hubs, sources, API health | Unknown graph state is never rendered as zero |
| Memories | Capture and retrieve Memory | Searchable chronological rows | Errors render inline near the workflow |
| Graph | Explore authorized Memory relationships | Interactive affinity map + selection inspector | Errors remain inside the Graph workspace |

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
- `src/lib/viz/graph.ts` owns the optimized D3 force layout, zoom/pan, node drag,
  label collision, and neighborhood paint state.
- `Sidebar.tsx` owns shell navigation, Workspace selection, mobile drawer, and search.
- Route files only load runtime configuration and render the feature boundary.

| Role | Component | Required states |
|---|---|---|
| Shell | `Sidebar` | desktop, mobile closed/open, Workspace-selected |
| Memory row | feature row | rest, hover, selected via detail, scope, search evidence |
| Composer | feature panel | empty, ready, saving, error |
| Detail | feature workspace | view/edit, saving, destructive, mobile stack |
| Graph | `GraphView` | loading, empty, mapped, filtered, selected, error |

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
- `Open Memory` enters the standard detail workspace; Back returns to Graph.
- Scope uses the graph palette plus explicit text in the inspector and legend, never
  color alone.

## 11. Loading, empty, error, and attention states

- Initial loading uses the plain `Opening Lore…` status.
- Empty collection invites the first Memory; empty search suggests changing the phrase.
- Recoverable request errors appear inline with a Dismiss action and `role=alert`.
- Disabled actions remain readable and do not use spinners as their only label.

## 12. Accessibility and interaction requirements

- Use `aside`, `nav`, `main`, headings, labels, fieldsets, and live regions correctly.
- All controls are keyboard reachable with a visible focus ring.
- Escape closes the mobile drawer and composer/detail overlays when applicable.
- Touch targets are at least 34px; primary actions are at least 38px.
- No behavior depends only on hover or color.

## 13. Anti-patterns

- Components consume native `Workspace`, `Memory`, `MemorySearchResult`, and
  `MemoryGraph` contracts. Do not introduce tool-shaped compatibility models,
  proxy calls, page/slug models, or generic upstream passthroughs.
- Do not create a second visual track beside the restored Lore shell.
- Do not use giant editorial headlines, pill-heavy ledgers, or colored scope decoration.
- Do not expose User-level embedding model selection; retrieval configuration is Workspace-scoped.
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
| 2026-08-05 | Restore Lore's complete Dashboard/Graph/Memories shell and optimized graph interaction around native Memory types | Preserve the product's mature interface without importing an external domain model | The temporary simplified Memory console |
| 2026-08-05 | Use Workspace-scoped search and configuration | Workspace is Lore's only tenant and retrieval boundary | User-scoped UI configuration |
| 2026-08-05 | Build Graph as an Actor-specific Memory-affinity read model | Preserve exploration without weakening RLS or reviving the deleted proxy | Deferred Graph placeholder |
