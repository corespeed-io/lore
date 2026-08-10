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
A durable record stored in exactly one Workspace and owned by exactly one User.
_Avoid_: Page, document, gbrain page

**Memory Owner**:
The User with write authority over a Memory, including one created on that User's
behalf by an Agent.
_Avoid_: Creating Agent, author identity

**Provenance**:
The recorded origin of a Memory, including the Agent that created it when
applicable; provenance does not determine ownership or visibility.
_Avoid_: Ownership, permission

**Scope**:
A Memory's visibility classification: shared or private.
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

**Memory Proposal**:
A content-bearing suggestion to create or change a canonical Memory, submitted by
an Actor for review by its owner User. It is owner-private, may cite only Memories
visible to its submitting Actor, and binds an update to one exact Memory version.
A proposal is not searchable Memory and cannot change canonical Memory until that
User explicitly accepts it. Each owner has at most 100 pending proposals in one
Workspace; reviewing one frees capacity for another submission.
_Avoid_: Draft Memory, automatic Memory, AutoDream result

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
