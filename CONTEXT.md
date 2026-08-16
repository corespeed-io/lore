# Lore Memory System

Lore stores and retrieves memories for people and the agents that act for them,
while preserving tenant and user-private isolation.

## Tenancy and identity

**Workspace**:
The sole tenant that contains members, granted Agents, and Memories.
_Avoid_: Organization, account, personal workspace

**User**:
A person represented inside Lore who may join multiple Workspaces and own multiple
Agents.
_Avoid_: Account, identity

**Identity**:
An authentication-provider identity that resolves to one User.
_Avoid_: User, login account

**Membership**:
The relationship that gives a User a role in one Workspace.
_Avoid_: Team member, Workspace user

## Agents and memory

**Agent**:
A user-owned non-human actor that may act in Workspaces where it has been granted
access. The Agent record and its grants are private to its owner User.
_Avoid_: Bot user, service tenant

**Agent Workspace Grant**:
The relationship that authorizes an Agent to act in one Workspace.
_Avoid_: Membership, Agent membership

**Agent Credential**:
A secret that authenticates one Agent; its authority is bounded by that Agent's
Workspace grants.
_Avoid_: User identity, Workspace token

**Memory**:
A bounded canonical knowledge record representing one coherent fact, decision,
constraint, procedure, or rationale, stored in exactly one Workspace and owned by
exactly one User. Raw documents and interaction transcripts are Observation
evidence, not Memory.
_Avoid_: Page, document, gbrain page

**Memory Chunk**:
A rebuildable, revision-tagged, non-overlapping retrieval partition of one Memory.
Ordered chunks reconstruct the canonical content exactly; they preserve formatting,
prefer structural boundaries, and never become independent Memories.
_Avoid_: Memory, document fragment, overlapping canonical content

**Memory Owner**:
The User with write authority over a Memory, including one created on that User's
behalf by an Agent.
_Avoid_: Creating Agent, author identity

**Provenance**:
The recorded origin of a Memory, including the Agent that created it when
applicable; provenance does not determine ownership or visibility.
_Avoid_: Ownership, permission

**Scope**:
A Memory or Episode's visibility classification: shared or private. Observations
inherit their Episode's scope.
_Avoid_: Access role, Agent scope

**Shared Memory**:
A Memory visible to active members and granted Agents in its Workspace while
remaining writable only by its owner User or an Agent acting for that User.
_Avoid_: Public Memory, team-owned Memory

**Private Memory**:
A Memory visible only to its owner User and that User's permitted Agents in the
same Workspace.
_Avoid_: Personal Memory, Agent-private Memory

**Memory Reference**:
An Actor-visible identifier used by inline `[[reference]]` navigation. A Memory may
define a human-readable `metadata.reference`; imports may preserve their source
reference in provenance metadata; otherwise its UUID is the reference. Ambiguous
or unreadable references never resolve.
_Avoid_: Global slug, authorization key, gbrain page slug

**Episode**:
A bounded, ordered recording of one real-world interaction or ingest session in a
Workspace. An Episode groups its Observations but is not an Actor, a Memory, or a
generic content source.
_Avoid_: Source, Agent session, conversation Memory

**Observation**:
An immutable, durable piece of evidence recorded inside one Episode, such as a
message, tool result, document fragment, or event. It remains until explicitly
forgotten, may support a Memory Proposal, and is not canonical Memory.
_Avoid_: Source, raw Memory, automatic Memory

**Memory Proposal**:
A content-bearing suggestion to create or change a canonical Memory, submitted by
an Actor for review by its owner User. It is owner-private, may cite only Memories
and Observations visible to its submitting Actor, may freeze typed Code Artifact
anchors visible at submission, and binds an update to one exact Memory version. A
proposal is not searchable Memory and cannot change canonical Memory until that User
explicitly accepts it. Acceptance also requires every cited Observation to remain
visible and atomically copies frozen Code anchors onto the accepted Memory without
re-resolving them. A content-free Observation id and the immutable Code locator/digest
survive deletion of their rebuildable source rows so missing evidence cannot be
silently ignored. Memory, Observation, and Code evidence share one 50-item limit.
Each owner has at most 100 pending proposals in one Workspace; reviewing one frees
capacity for another submission.
Pending and reviewed proposal content expires after 30 days. Forgetting a target or
accepted Memory removes its associated proposal content immediately.
_Avoid_: Draft Memory, automatic Memory, AutoDream result

## Code-aware evidence

**Code Repository**:
A Workspace-scoped identity for one source repository whose index contains no
repository credential. Its indexed content is shared derived evidence available
only to active members and granted Agents in that Workspace.
_Avoid_: Git credential, Memory owner, global repository

**Code Revision**:
One immutable, content-bound repository snapshot identified by a full Git
commit OID. The trusted local-Git path resolves that exact commit, reads its
object database rather than the working tree, and binds the revision to an
exact Git tree OID plus an independent complete-tree digest. Repeating the same OID and source/tree digests
is idempotent; the same OID with different or unauthenticated source evidence is a
conflict. Retrieval always selects an exact Code Revision before ranking artifacts.
_Avoid_: Branch head, mutable working tree, latest code

**Code Revision File**:
One immutable entry in an authenticated Code Revision's complete Git tree
manifest. It records path, mode, Git object type/OID, byte size, optional content
digest, and exactly one typed outcome: indexed or excluded for binary, empty,
invalid UTF-8, oversized, submodule, symlink, or unsupported content. Every tree
entry must be accounted for; it is manifest evidence, not a Code Artifact.
_Avoid_: Untracked working-tree file, silent omission, generic document chunk

**Code Index Generation**:
A rebuildable parser, symbol-extraction, chunking, and dependency-edge output for one Code Revision,
identified by an explicit indexer revision. Re-indexing with changed derivation
logic creates a new generation without changing the immutable source snapshot.
An unchanged Git blob may reuse a prior Workspace-visible generation's validated
parse/chunk/dependency output only when object OID, content digest, and indexer revision all
match. Rename reuse remaps path-qualified identities into the new revision; the new
generation still owns its own immutable Artifact membership rows. Artifact source
text and its content-only lexical indexes are immutable, Workspace-scoped payloads
identified by indexer revision plus a database-verified SHA-256 digest, so unchanged
and renamed chunks can share those bytes without sharing path identity. Ordered,
path-free Symbol Sets and Dependency Sets are also immutable Workspace-scoped
derivation payloads keyed by indexer revision and SHA-256. Artifact memberships
project the current path, while dependency resolution stays generation-local.
It moves through `building`, `ready`, `active`, `retiring`, or `failed`; search
serves only active, exact-coverage generations.
_Avoid_: Code Revision, embedding generation, mutable in-place refresh

**Code Index Job**:
A durable, bounded-attempt lease request to index one operator-configured local
repository at one exact commit. Public clients provide only repository key, commit
OID, and optional source ref. The local path is operational input and is never
returned or accepted from a model.
_Avoid_: Memory job, caller-supplied path, branch-head indexing

**Code Artifact**:
A rebuildable retrieval unit derived from one Code Index Generation. Supported
languages use AST/symbol-aware units; unsupported or substantially malformed
sources retain their formatting in bounded text fallbacks. A Code Artifact records
one exact source span, path, range, parser state, content hash, payload reference,
and its ordinal in the file. Structural chunks preserve every source character across their ordered
spans. A large declaration may produce several Artifacts with one declaration key
and distinct declaration-chunk ordinals; one Artifact may represent multiple Code
Artifact Symbols.
It is code evidence, never canonical Memory. A decision or rationale may cite a
Code Artifact, but re-indexing code cannot silently rewrite that Memory.
_Avoid_: Memory, Observation, generic document chunk

**Code Artifact Symbol**:
A language-derived definition represented by one Code Artifact. Its symbol key is
the logical path-qualified symbol identity; its declaration key distinguishes one
declaration or overload; the Artifact's declaration-chunk ordinal identifies a
bounded segment of that declaration. Destructuring may attach several Symbols to
one exact Artifact without duplicating source content. The immutable path-free
ordered symbol derivation may be shared across revisions; the Artifact path is
applied when the exact-revision symbol identity is read.
_Avoid_: Code Artifact id, chunk suffix, text-search match

**Code Dependency Edge**:
Immutable rebuildable evidence that one exact Artifact or Artifact Symbol imports,
calls, or references a target inside one Code Index Generation. The immutable
path-free raw target/site derivation is an ordered member of the source Artifact's
shared Dependency Set. The generation-local edge stores that member's ordinal and
its exact-revision target resolution. Resolution is explicitly `resolved`,
`ambiguous`, or `unresolved`; Lore never guesses between same-name definitions.
File-level imports remain distinct from symbol-level dependencies. Callers/callees
queries select one Workspace, repository, full commit OID, and active generation
before applying a bounded result limit.
_Avoid_: Memory Link, inferred canonical fact, cross-revision edge

**Memory Code Evidence**:
A typed citation from one canonical Memory to immutable historical code evidence.
Its anchor records repository, exact cited commit, path, symbol/declaration locator,
declaration-chunk ordinal, Artifact id, content digest, and a SHA-256 fingerprint of
the ordered declaration chunk sequence with the cited chunk masked out, independently
of rebuildable Artifact retention. This context fingerprint lets a changed chunk keep
its ordinal only when every surrounding declaration partition remains unchanged;
otherwise structural reorder/replacement is `ambiguous`.
Its relationship is `supports`, `contradicts`, `implements`, or `rationale`;
side-effect-free assessment may report `current`, `moved`, `changed`, `deleted`,
`ambiguous`, or `unverifiable` for one target revision. Explicit revalidation may
persist that same assessment when the Actor can write the Memory. Neither operation
rewrites the Memory.
_Avoid_: Memory content, automatic Memory update, live Artifact foreign key

**Retrieved Context**:
A bounded, Actor-visible read model that composes independently authorized Memory
evidence, exact-revision Code Artifacts, and side-effect-free Memory Code Evidence
assessment for one question. It records its route and receipt, keeps evidence
families typed and separate, and may explicitly abstain. It is transient retrieval
output: it owns no canonical content and persists no revalidation state. The
original question determines routing; bounded channel-specific Memory or Code
queries remain explicit in the receipt.
For change questions, local freshness describes the cited Artifact itself while
contextual impact describes its bounded direct dependencies. Contextual comparison
is exact-revision, uses path-qualified symbols, and fingerprints every chunk in a
logical declaration. It is `unknown` or `possibly_affected` when traversal is
truncated or resolution is incomplete; it is never permission to mutate Memory.
_Avoid_: Merged Memory/Code store, generated answer, implicit latest revision

## Graph

**Memory Graph**:
An Actor-specific view of visible Memories and the relationships among them. A
Memory Graph never contains a node or relationship whose endpoint the Actor
cannot read.
_Avoid_: Workspace graph, global graph, gbrain graph

**Memory Link**:
A durable, directed relationship from one Memory to another Memory in the same
Workspace, visible only when the Actor can read both endpoints.
_Avoid_: Edge, gbrain link, Memory Affinity

**Memory Affinity**:
A derived, non-authoritative relationship between two visible Memories whose
content is similar enough to help exploration. It is recalculated from the
current authorized Memory set and is not itself a stored Memory.
_Avoid_: Knowledge fact, Memory Link, graph ownership

**Embedding Configuration**:
The deployment-wide provider and model selected by a self-host operator for indexing
and searching Memories. Lore v1 fixes the vector dimension and preprocessing
revision as protocol invariants; they are not operator, User, Workspace, or Agent
settings. Candidate distance is a separately calibrated retrieval parameter and
does not define the embedding space. The Qwen3/Ollama `lore-embedding-v2` protocol
applies Qwen3-Embedding's official retrieval instruction to query texts while leaving
indexed document text and canonical chunking unchanged; unrelated provider/model
spaces remain on v1.
_Avoid_: Workspace Retrieval Profile, User embedding model, Agent retrieval setting

**Embedding Generation**:
One immutable deployment-wide vector space identified by provider, model, fixed
dimension, and preprocessing revision. A replacement is built beside the active
generation, becomes active only after exact coverage validation, and leaves the old
generation retiring for a bounded rollback window.
_Avoid_: Mixed vector space, Workspace embedding profile, in-place model overwrite

**Memory Mutation Event**:
A content-free, expiring outbox record committed in the same transaction as a
Memory or Memory Link create/update/delete. It may contain bounded ids, versions,
changed-field names, and content hashes, but never Memory content, query text,
credentials, or provider payloads.
_Avoid_: Permanent audit copy, Memory revision, AutoDream result

**Workspace Archive**:
A checksummed, versioned export of only the Memories and Links visible to one human
Actor under RLS. Import is bounded, dry-runnable, requires explicit source-owner
remapping, and records source provenance. It is distinct from a full PostgreSQL
backup.
_Avoid_: Database dump, Workspace clone, cross-tenant admin export

**Reranking Configuration**:
The optional deployment-wide provider, model, candidate budget, instruction, and
calibrated rank-fusion/abstention/diversity settings used to reorder only the
candidate evidence passages already authorized and retrieved by Lore. A calibrated
local temporal rank-fusion weight may share that candidate budget without a model.
A reranker is never allowed to broaden visibility or become a User, Workspace, or
Agent setting; provider failure falls back to deterministic fused retrieval.
_Avoid_: Workspace reranker, global candidate search, authorization filter

**Query Planning Configuration**:
The optional deployment-wide chat model, instruction, and bounded query budget used
to decompose a recall question into distinct evidence queries. The planner sees only
the question; Lore retains the original query and applies the same Actor/RLS boundary
to every expansion before fusing results. Failure falls back to the original query.
_Avoid_: Workspace query planner, answer generation, Memory-aware planner prompt

**Benchmark Reader and Judge**:
Versioned, evaluation-only model roles. The Reader answers from only the evidence
returned by Lore; the Judge applies a dataset's pinned scoring rubric to that answer.
Their provider/model/revision, latency, and token use belong in the evaluation report
and are never deployment retrieval settings. An unresolved judge case is excluded
from accuracy and makes the score incomplete.
_Avoid_: production answer model, hidden evaluator, partial leaderboard score

**Conflict Resolution Evaluation**:
An evaluation in which ordered observations may supersede earlier facts and an
answer may require multiple current facts. It measures whether ingestion preserves
sequence and retrieval supplies enough authorized evidence for the Reader to select
the current chain; it does not authorize automatic production-Memory rewriting.
_Avoid_: AutoDream, destructive deduplication, newest timestamp always wins

**Benchmark Graph Dataset**:
A deterministic, synthetic node-and-link dataset used only to stress graph layout
and rendering. It is not a Memory Graph and carries no product authorization semantics.
_Avoid_: Memory Affinity, production Workspace, evaluation suite

## Evaluation

**Evaluation Suite**:
A versioned collection of cases used to measure retrieval quality and isolation.
_Avoid_: AutoDream, calibration profile

**Evaluation Run**:
One execution of an Evaluation Suite against a specific Lore version and
configuration.
_Avoid_: Benchmark dataset, Dream run
