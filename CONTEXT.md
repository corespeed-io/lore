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
