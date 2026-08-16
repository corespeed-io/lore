# `@corespeed/lore-mcp`

External stdio Model Context Protocol adapter for Lore. It exposes bounded Memory
read and write tools, durable non-canonical `lore_observe` Episode recording, and
human-reviewed `lore_propose` submissions for one configured Actor and Workspace.
`lore_propose.codeEvidence` accepts bounded `{ artifactId, relationship }` entries,
freezes exact Code anchors for human review, and copies them to the Memory only on
acceptance. Code, Memory, and Observation evidence share one 50-item limit.
Its separate `lore_code_*` family searches exact revisions, queries bounded
callers/callees with explicit ambiguous or unresolved targets, queues only
operator-configured repositories, reads safe job status, and manages typed
Memory-to-Code evidence without accepting a Workspace or filesystem path.
It delegates all access control to Lore/Postgres RLS and stores no Memory or
authorization state.

`lore_retrieve_context` is the read-only orchestration surface for answering with
both stores. It routes the question, retrieves only Actor-visible Memory evidence,
searches Code only when an operator repository key and exact full commit OID are
present, and assesses attached Code citations without persisting revalidation.
For routed change questions, v2 separately reports bounded exact-revision
contextual impact over each citation's direct dependencies; incomplete resolution
or truncation stays explicit instead of being treated as unaffected.
The result keeps Memory, Code, anchors, conflicts, and a retrieval receipt in
separate bounded fields; the tool never accepts a Workspace or repository path.
The original `query` always controls routing. Optional `memoryQuery` and
`codeQuery` carry agent-planned channel queries in the same request and are echoed
in the receipt so retrieval remains auditable.

Hosts should apply Lore's `required | auto | off` grounding policy before model
tool selection; `@corespeed/lore-sdk` exports the versioned gate as
`planRetrievalGrounding`, and the Python SDK ships the aligned
`plan_retrieval_grounding`. Grounding is required for prior Workspace decisions, user-specific
facts, and current or exact-revision repository claims; it stays off for tasks fully
supported by supplied text and unconstrained brainstorming. When Code truth is
required but exact revision context is unavailable, the gate returns
`shouldClarify` with a ready-made clarification — asking for the exact commit OID
when a repository is configured, or pointing the operator at
`LORE_CODE_REPOSITORIES` when none is — and hosts return it deterministically,
without a model turn, instead of substituting Memory search or letting the model
choose between clarifying and abstaining. After a required compound read, expose
specialist Memory, Code search, or dependency tools only for bounded follow-up.

Memory tools accept one coherent canonical record, with a hard limit of 32,000
Unicode characters and 64 derived chunks. Use `lore_observe` with a document
Episode for longer raw source material.

See the repository's [developer integration guide](https://github.com/corespeed-io/lore/blob/main/docs/developer-integration.md)
for secure configuration.
