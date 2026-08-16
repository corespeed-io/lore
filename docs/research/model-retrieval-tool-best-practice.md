# Model-triggered Memory + Code retrieval: evidence and recommendation

Researched: 2026-08-15

Question: Is it best practice to expose one compound Memory + Code retrieval tool
and rely on the model to decide whether to call it?

## Executive conclusion

**A compound retrieval tool is a good default agent interface; relying on an
unconstrained model to call it is not a reliability guarantee.** Lore should use a
hybrid architecture:

1. keep `lore_retrieve_context` as the single high-level, read-only grounding
   workflow;
2. keep Memory search, exact-revision Code search, and dependency traversal as
   specialist drill-down tools rather than merging their semantics or storage;
3. let Lore's server-side route choose Memory, Code, both, or abstain *inside* the
   compound call;
4. let the host/client enforce that the compound call happens for questions whose
   correctness depends on Workspace facts, prior decisions, or the exact repository
   revision;
5. use adaptive/model-selected retrieval only for genuinely optional grounding,
   and calibrate it per model and tool surface with retrieval-necessity evals.

In short:

```text
one default model-facing retrieval workflow       yes
one shared Memory/Code search implementation       no
model `auto` as the only retrieval trigger         no
host-enforced grounding for evidence-critical work yes
specialist tools for follow-up exploration         yes
```

This distinction matters because MCP defines tools as model-controlled but does
not prescribe or guarantee a client interaction policy. A server can make a tool
easy to discover; the client/harness must guarantee a call when one is required
([MCP Tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)).

## What the evidence establishes

### 1. Tool availability does not imply tool use

OpenAI's Agents SDK documentation states this directly: supplying tools does not
mean the LLM will use one. `auto` delegates the decision to the model, `required`
requires some tool, and naming a tool requires that specific tool
([OpenAI Agents SDK: forcing tool use](https://openai.github.io/openai-agents-python/agents/#forcing-tool-use)).
The Responses API has the same control distinction: `auto` may emit a message or
one or more tool calls, whereas `required` must emit one or more allowed tool calls
([OpenAI Responses API: `tool_choice`](https://platform.openai.com/docs/api-reference/responses-streaming/response/output_item/added)).

This is not merely an API wording issue. BFCL V4's controlled web-search
evaluation gives models search and page-fetch tools, then identifies “avoids tool
usage” as a recurring failure mode: some models answer from parametric knowledge
despite access to the tools, producing outdated, incomplete, or unsupported
answers. Removing tool access sharply reduces accuracy on its multi-hop set,
confirming that the skipped calls were consequential rather than redundant
([BFCL V4 Web Search, Sections 6.2–6.3](https://gorilla.cs.berkeley.edu/blogs/15_bfcl_v4_web_search.html)).
The peer-reviewed BFCL paper likewise concludes that, although state-of-the-art
models are strong on single-turn function calls, dynamic decision-making, memory,
and long-horizon use remain open challenges
([Patil et al., ICML 2025](https://proceedings.mlr.press/v267/patil25a.html)).

Anthropic's first-party tool engineering report describes the same class of
failures: agents can call the wrong tool, pass wrong parameters, call too few
tools, or mishandle responses. It recommends measuring expected tool calls in
task evals while avoiding a single overfitted trajectory
([Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)).

**Implication for Lore:** improving `lore_retrieve_context`'s name, description,
schema, and examples can improve call recall, but cannot turn model-controlled
selection into a hard invariant.

### 2. Always retrieving is also not the universal answer

The retrieval literature consistently rejects indiscriminate fixed retrieval:

- Self-RAG trains explicit retrieval/reflection tokens so the model retrieves on
  demand; it reports improvements over fixed retrieval-augmented baselines across
  open-domain QA, reasoning, fact verification, and long-form generation
  ([Asai et al., ICLR 2024](https://openreview.net/forum?id=hSyW5go0v8)).
- Adaptive-RAG uses a separate learned classifier to select no retrieval,
  single-step retrieval, or iterative retrieval from question complexity and
  reports better efficiency and accuracy than its evaluated baselines
  ([Jeong et al., NAACL 2024](https://aclanthology.org/2024.naacl-long.389/)).
- A later comparison of 35 adaptive methods across six QA datasets finds no single
  method dominates every quality and efficiency axis; comparatively simple
  uncertainty estimators often match the QA performance of more complex pipelines
  while being more efficient
  ([Moskvoretskii et al., ACL 2025](https://aclanthology.org/2025.acl-long.319/)).

Lore's own small real-Git experiment points in the same direction. Its selective
joint route passed all six tasks, while an always-on Memory + Code union had a
`0.667` reader pass rate, `0.833` Code recall, and `0.5` route accuracy
([joint-memory-code-real-git-v5 baseline](./joint-memory-code-real-git-v5-baseline.md)).
That is useful product-local evidence, although six tasks are not enough to settle
the production policy.

**Implication for Lore:** “mandatory” should mean mandatory *for a recognized
grounding requirement*, not unconditional Memory + Code injection on every turn.
Once invoked, `lore_retrieve_context` should retain its selective internal route
and bounded typed result rather than always searching both stores.

### 3. Guarantees belong in a workflow; discretion belongs in an agent

Anthropic distinguishes workflows—tools and models connected by predefined code
paths—from agents, which dynamically direct their own tool use. Its guidance says
workflows offer predictability and consistency for well-defined tasks, while agents
are appropriate when flexibility is needed. Its routing pattern may use an LLM or
a traditional classifier when the categories are distinct and classification can
be measured accurately
([Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)).

That maps cleanly onto Lore:

```text
Host policy gate
  ├─ required grounding ──> invoke lore_retrieve_context
  ├─ optional grounding ──> evaluated router/model decision
  └─ grounding irrelevant ─> answer without Lore retrieval

lore_retrieve_context
  └─ joint-memory-code-v2 route
       ├─ memory-only
       ├─ code-only
       ├─ both
       └─ abstain

Model receives typed packet
  └─ may drill down with lore_search / lore_code_search /
     lore_code_dependencies when the packet is insufficient
```

The outer gate answers “must this response be grounded at all?” The existing Lore
route answers the separate question “which authorized evidence stores are useful?”
Conflating those two decisions is what creates the current concern.

### 4. One high-level tool plus primitives is preferable to either extreme

Anthropic recommends a small set of thoughtful tools aimed at high-impact
workflows, notes that tools can consolidate frequently chained API calls, and warns
that too many overlapping tools distract agents. Its examples specifically favor
a `get_customer_context` workflow over separate customer, transaction, and note
lookups. The same guidance still says every tool needs a distinct purpose and that
tool response shape must be selected by evaluation
([Anthropic: Choosing the right tools](https://www.anthropic.com/engineering/writing-tools-for-agents#choosing-the-right-tools-for-agents)).

This supports the current Lore division:

- `lore_retrieve_context`: first-call workflow for answering with provenance;
- `lore_search`: targeted canonical Memory lookup;
- `lore_code_search`: targeted exact-revision Artifact lookup;
- `lore_code_dependencies`: explicit callers/callees traversal;
- separate mutation and persisted citation-management tools.

It does **not** support replacing these with one unbounded “do anything with Lore”
tool. The compound tool should remain read-only, bounded, typed, and focused on one
workflow: assemble answer context. Specialist tools should be namespaced clearly
and ideally loaded progressively where the client supports deferred tools. OpenAI
similarly recommends namespaces over many individually exposed functions and a
small namespace—roughly fewer than ten functions—as a rule of thumb
([OpenAI Agents SDK: tools and namespaces](https://openai.github.io/openai-agents-python/tools/)).

## Recommended Lore invocation policy

The policy should be a deployment/client contract, not hidden inside the MCP
server. A pure MCP server cannot force an arbitrary host's model to call a tool.

| Request class | Invocation | Internal route | Reason |
|---|---|---|---|
| Current implementation, exact symbol/path, behavior at a commit | Host invokes or forces `lore_retrieve_context` | `code-only` or `both` when rationale is requested | Parametric knowledge cannot establish exact-revision truth |
| “Why did we choose this?”, prior decisions, user/Workspace-specific facts | Host invokes or forces `lore_retrieve_context` | `memory-only` or `both` when code is in scope | The required fact is outside the base model |
| “Does current code still match the decision?”, change impact, regression risk | Host invokes or forces `lore_retrieve_context` | `both` | The task explicitly requires cross-store evidence |
| Open-ended brainstorming that does not claim repository or Workspace facts | `auto` or no retrieval | usually `abstain` | Forced evidence adds latency and can distract |
| Transformation of complete user-provided text/code | normally no retrieval | `abstain` | The prompt already contains the source of truth |
| Ambiguous request where repository/commit is unavailable | clarify or Memory-only; never guess repository state | `memory-only`/`abstain` | Exact Code evidence requires host-known repository key plus commit OID |

For an OpenAI-based host, the strongest sequence is:

1. restrict allowed tools for the grounding turn to
   `lore_retrieve_context` and use named `tool_choice`, or use `required` only when
   that is the sole allowed callable tool;
2. execute the read-only tool;
3. return to `auto` for synthesis and optional drill-down, avoiding a forced-tool
   loop.

If `required` is used while unrelated action tools remain available, it proves only
that *some* tool was called—not that retrieval occurred. If the MCP host exposes no
tool-choice control, the best available fallback is a strong system instruction and
tool description, but the integration must label that behavior “best effort,” not
“guaranteed.”

### Suggested model guidance

The high-level tool description or host instruction should contain trigger
conditions rather than only describing capabilities. For example:

> Before answering, use `lore_retrieve_context` whenever correctness depends on
> the configured Workspace's prior knowledge, user-specific facts, or the exact
> repository commit. Use it for “current code,” “why was this chosen,” “does the
> code still match,” and change-impact questions even if you believe you already
> know the answer. Do not use it for general knowledge or transformations fully
> supported by the user's supplied content.

This should improve discovery, but remains subordinate to the host-level policy for
required cases. Clear instructions reduce ambiguity, but provider guidance still
recommends testing and iterating rather than assuming prompt compliance
([OpenAI practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/),
[Anthropic context engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

## Evaluation required before calling this production best practice

Lore should add a model-facing **retrieval policy evaluation**, distinct from
retriever Recall@k. Retriever quality is irrelevant when the model never invokes
it.

### Test strata

Use realistic tasks with ground-truth labels:

1. `must-call / memory-only`;
2. `must-call / code-only`;
3. `must-call / both`;
4. `must-not-call`;
5. `must-clarify` because exact revision context is absent;
6. `drill-down-required` after the first packet is truncated, ambiguous, or
   reports unknown contextual impact;
7. adversarial prompts where the model appears to know a plausible but stale
   answer;
8. no-answer cases where retrieval should abstain rather than manufacture support.

Run multiple trials for every supported model/version because tool selection is
non-deterministic and model-sensitive. Anthropic recommends grading both outcomes
and transcripts; code-based graders can verify exact tools, arguments, number of
turns, and token use
([Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).

### Required metrics

- required-retrieval false-negative rate;
- unnecessary-retrieval false-positive rate;
- route accuracy: Memory / Code / both / abstain;
- repository key and exact commit correctness;
- evidence-level answer recall, not merely parent record hit rate;
- grounded answer correctness and citation/locator correctness;
- no-answer false-positive rate;
- successful follow-up traversal when the first packet is incomplete;
- p50/p95 latency, tool calls, input/output tokens, and provider cost;
- result stability across repeated trials and model upgrades.

### Minimum ablation

Compare the same task bank under:

- A: all primitive tools, `auto`;
- B: compound plus primitives, `auto`;
- C: compound plus primitives, `auto`, with explicit trigger examples;
- D: host-enforced compound retrieval for `must-call` cases, `auto` otherwise;
- E: unconditional retrieval on every task.

The expected architecture is D, but the result should decide. In particular, B/C
measure whether the compound tool improves discovery; D measures the value and
cost of a workflow guarantee; E quantifies irrelevant-context damage.

## Conflicts and limitations

- Adaptive-RAG, Self-RAG, and the 35-method ACL comparison evaluate QA retrieval,
  not Lore's exact-revision Code plus canonical Memory packet. They justify
  selective retrieval as a hypothesis and architecture pattern, not Lore's final
  thresholds.
- Self-RAG learns special tokens and Adaptive-RAG trains a classifier. Their
  results do not imply that an arbitrary instruction-tuned model's ordinary MCP
  `auto` decision is equally calibrated.
- BFCL V4 establishes that tool avoidance occurs, but its web benchmark is not a
  direct estimate of Lore's miss rate. Lore must measure every supported model and
  host integration.
- Forced retrieval raises latency/cost, and irrelevant passages can degrade an
  answer. This is why the outer mandatory gate must be narrow and the internal
  Memory/Code route selective.
- A compound tool can become opaque or over-broad. Lore should preserve separate
  typed evidence arrays, route/receipt fields, exact revision selectors, bounded
  budgets, explicit truncation, and specialist follow-up tools.
- MCP standardizes discovery and invocation, not the host's policy. “Always ground
  code answers” therefore cannot be a server-only guarantee across third-party MCP
  clients.

## Decision for the current design

The existing interface is directionally correct: one bounded
`lore_retrieve_context` call orchestrates two specialized retrievers and returns
Memory, Code, anchors, conflicts, and receipt fields separately, while dedicated
read tools remain available for exploration
([current MCP implementation](../../packages/mcp/src/index.ts),
[integration contract](../developer-integration.md)).

The design should **not** be replaced with two mandatory first calls, and the
Memory and Code indexes should **not** be merged. The necessary change is at the
invocation-policy layer:

> Expose one compound tool by default, but guarantee evidence-critical retrieval
> in the host workflow; reserve model-selected `auto` retrieval for optional cases.

That is the most evidence-supported interpretation of current best practice.

## Source and collection notes

Only original papers, official protocol/API documentation, first-party agent
engineering reports, and Lore's own benchmark were promoted into findings. The
Agent Reach Exa MCP route was unavailable in this workspace (`Unknown MCP server
'exa'`), so official-domain web search and direct official-page reading were used
as the documented fallback. No community post or secondary summary is cited.
