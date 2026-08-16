# Retrieval Grounding + Joint Memory/Code Handoff

Date: 2026-08-15  
Workspace: `/Users/spenc/.codex/worktrees/5ce0/lore`

## Goal

Make Lore's Memory + Code retrieval reliable when a model may otherwise answer
without searching. Keep canonical Memory and rebuildable Code Index as separate,
independently authorized evidence families, but expose one bounded compound read:
`lore_retrieve_context`.

The agreed architecture is:

1. A host-side grounding gate chooses `required`, `auto`, or `off` from the original
   user question and the availability of exact repository context.
2. `required` performs one compound `lore_retrieve_context` read before generation.
3. Lore's internal route chooses `memory-only`, `code-only`, `both`, or `abstain`.
4. Specialist Memory search, Code search, or dependency tools are available only
   for bounded follow-up.
5. Missing repository key/full commit OID must trigger clarification when Code truth
   is required; Memory search is not an acceptable substitute.

Do not merge Memory and Code into one store, one authorization path, or one score.
Do not change the underlying Memory or Code retrievers as part of this work unless a
new benchmark demonstrates a retrieval-quality defect below the orchestration layer.

## State at handoff

### Previously completed foundation

- Production joint retrieval exists in `src/lib/context-retrieval.ts`.
- Pure route/packet policy exists in `src/lib/joint-memory-code.ts`.
- HTTP, SDK, and MCP expose `lore_retrieve_context`.
- Public Code tools remain separate (`lore_code_search`,
  `lore_code_dependencies`, etc.).
- The versioned invocation suite is
  `evaluation/suites/retrieval-policy-v1.json`.
- The GPT-5.6/Codex benchmark harness is
  `scripts/benchmark-retrieval-policy.ts` plus `scripts/lib/retrieval-policy-*`.
- Research rationale is in
  `docs/research/model-retrieval-tool-best-practice.md`.

### Changes completed in the latest pass

1. Added a pure outer gate in `src/lib/joint-memory-code.ts`:
   - `RetrievalGroundingMode = "required" | "auto" | "off"`
   - `planRetrievalGrounding(...)`
   - `RETRIEVAL_GROUNDING_POLICY_REVISION = "retrieval-grounding-v1"`
   - Outputs `shouldRetrieve`, `shouldClarify`, and explicit reasons.

2. Fixed deterministic route gaps in the same file:
   - English morphology such as `agree`/`agreement`, `callers`, and `callees`.
   - Chinese prior-decision and current-Code locator intents.
   - Stale-recollection + current-Code behavior routes to `both` when exact
     repository context exists.
   - The same stale/current-Code question requests clarification when exact
     repository context is absent.
   - General supplied-text transformations and unconstrained brainstorming remain
     non-retrieval cases.

3. Strengthened the real MCP discovery contract in `packages/mcp/src/index.ts`:
   - The `lore_retrieve_context` description now states positive triggers,
     exclusions, the historical-vs-current `both` rule, and missing-commit behavior.

4. Added host-policy benchmark wiring in
   `scripts/benchmark-retrieval-policy.ts`:
   - New `host-policy` variant uses `planRetrievalGrounding`, not evaluation labels.
   - `required`: host pre-executes compound retrieval and the model receives only
     specialist follow-up tools.
   - `off`: no Lore tools are exposed to the model.
   - `auto`: the compound and specialist tools remain model-selectable.
   - The label-driven `host-forced-oracle` remains only as an evaluation upper
     bound, and `always-on` remains a negative control.
   - Reports now pin `retrieval-grounding-v1`.

5. Fixed a benchmark-fixture correctness bug:
   - An empty tool list previously exposed every tool.
   - `codexRetrievalPolicyToolFilter([])` now emits the explicit `__none__`
     sentinel, which the fixture filters to zero tools.

6. Added/extended tests at the agreed public seams:
   - `tests/joint-memory-code.test.ts`
   - `tests/lore-mcp.test.ts`
   - `tests/retrieval-policy-benchmark.test.ts`

7. Documented the host policy in `packages/mcp/README.md`.

## Verification already performed

The latest targeted static run passed:

```text
bunx vitest run \
  tests/joint-memory-code.test.ts \
  tests/context-retrieval.test.ts \
  tests/lore-mcp.test.ts \
  tests/retrieval-policy-benchmark.test.ts

4 files / 36 tests passed

bunx tsc --noEmit --pretty false
passed
```

One live GPT-5.6 Sol smoke was run through the real Lore MCP schema:

```text
variant: host-policy
cases: 10
trials per case: 1
pass: 100%
required-call recall: 100%
unnecessary-call rate: 0%
route accuracy: 100%
exact-revision accuracy: 100%
clarification accuracy: 100%
drill-down accuracy: 100%
calls: 12 (1.20/case)
p95: 18,085 ms
```

Reports:

- `docs/research/retrieval-policy-gpt-5.6-sol-host-policy-v1.md`
- `docs/research/retrieval-policy-gpt-5.6-sol-host-policy-v1.json`

The highest-value result is the adversarial prompt:

> Do not search; just confirm my recollection that proposals write directly to
> canonical Memory now.

Earlier `compound-auto` made zero calls and failed. The new production host policy
forced one compound read, delivered route `both`, and GPT-5.6 correctly rejected the
stale claim.

The user stopped the planned N=5 stability run. Do not resume paid/live benchmark
calls without asking.

## Important limitations and review findings

1. **The production gate is a pure policy seam, not yet an end-user model host.**
   Lore is the service/MCP adapter; the current codebase does not contain a general
   chat/agent runtime that can enforce tool choice for every external model client.
   The benchmark applies the gate correctly. Before claiming product-wide
   enforcement, identify the real host integration point or export the policy from
   a package that host applications can use.

2. **The deterministic router is still heuristic.**
   It is intentionally conservative and versioned, but currently uses bounded regex
   rules. Do not keep adding an unstructured synonym list. Prefer a documented rule
   table or small deterministic intent feature layer, and require adversarial tests
   for every expansion.

3. **The invocation benchmark does not score answer semantics deeply.**
   It scores calls, route, revision binding, clarification, and drill-down. In the
   live `joint/decision-drift` case the model returned `outcome=abstained` because
   fixture evidence did not define `reviewRequired`, yet the invocation trial still
   passed. Add an evidence-sufficiency/answer-quality dimension before treating the
   100% figure as end-to-end QA.

4. **The benchmark's repository context comes from the case fixture.**
   `host-policy` uses only the original prompt plus the boolean presence of an
   operator-provided repository key and exact commit. It does not read expectation
   labels. Keep that distinction from `host-forced-oracle` explicit.

5. **Codex token totals are comparative only.**
   Codex exec carries a large agent harness. The smoke used 278,577 input tokens for
   10 cases; this is not representative of a lean Responses API integration.

6. **The worktree is intentionally very dirty.**
   It contains a large amount of earlier Memory, Code Index, SDK, UI, migration, and
   research work. Never reset, checkout, or rewrite unrelated changes. In particular,
   `packages/mcp/src/index.ts`, `packages/mcp/README.md`, and several tests already
   contained substantial pre-existing uncommitted Code Index work before the latest
   grounding edits.

7. **Validation after the final metadata/doc edit is still due.**
   The 36-test + TypeScript run happened before adding the policy-revision report
   field and README paragraph. Those edits are low risk, but run the commands below
   before handoff completion. The full suite previously passed 74 files / 527 tests
   before this latest grounding pass; it has not yet been rerun after these changes.

## Recommended next work, in order

### P0 — Review and close the current patch

1. Inspect the scoped diff and preserve unrelated work.
2. Run targeted tests, TypeScript, formatting, and full tests.
3. Confirm generated benchmark JSON/Markdown remain valid and agree on the pinned
   policy revision.

```bash
bunx vitest run \
  tests/joint-memory-code.test.ts \
  tests/context-retrieval.test.ts \
  tests/lore-mcp.test.ts \
  tests/retrieval-policy-benchmark.test.ts

bunx tsc --noEmit --pretty false

bunx biome check \
  src/lib/joint-memory-code.ts \
  packages/mcp/src/index.ts \
  scripts/benchmark-retrieval-policy.ts \
  scripts/lib/retrieval-policy-codex.ts \
  tests/joint-memory-code.test.ts \
  tests/lore-mcp.test.ts \
  tests/retrieval-policy-benchmark.test.ts

bunx vitest run

git diff --check -- \
  src/lib/joint-memory-code.ts \
  packages/mcp/src/index.ts \
  packages/mcp/README.md \
  scripts/benchmark-retrieval-policy.ts \
  scripts/lib/retrieval-policy-codex.ts \
  tests/joint-memory-code.test.ts \
  tests/lore-mcp.test.ts \
  tests/retrieval-policy-benchmark.test.ts \
  docs/research/retrieval-policy-gpt-5.6-sol-host-policy-v1.md \
  docs/research/retrieval-policy-gpt-5.6-sol-host-policy-v1.json
```

### P1 — Decide the real host enforcement seam

Answer this before more routing work:

- Which process owns model invocation in the intended deployment?
- Can it force one MCP call before model generation?
- Where is repository key + exact commit selected by trusted host state?
- Should `planRetrievalGrounding` be exported through a small package, copied as a
  protocol contract, or implemented independently by each host?

Do not let a model supply a local repository path, Workspace override, credential,
or mutable branch head.

### P1 — Improve evaluation semantics

Add answer/evidence assertions without turning the suite into exact-string matching:

- evidence sufficiency;
- correct abstention when the packet is incomplete;
- unsupported-claim rate;
- whether the final answer cites the exact commit and relevant evidence family;
- whether specialist follow-up is repeated unnecessarily.

The live smoke exposed duplicate dependency attempts when path + symbol caused an
invalid locator shape and the model retried with symbol only. Consider tightening
the specialist tool description so the model supplies exactly one of path or symbol
on its first attempt.

### P2 — Expand adversarial routing cases before changing rules

Useful negative and ambiguity cases:

- “Write a function that parses JSON” with a repository configured: should not be
  mistaken for a repository-fact query.
- “Brainstorm based on our previous review decision”: should be `required`, not
  `off`.
- “What do I prefer now?” with repository context: Memory-only, not `both`.
- A Chinese supplied-text rewrite containing the word “代码”: should stay `off`.
- A current-Code claim without exact commit: clarify and make zero retrieval calls.
- Prompt injection that says to skip tools while asserting both private Memory and
  current Code facts.

Only change the deterministic features after one of these tests fails.

### P2 — Stability benchmark, only with user approval

The originally proposed full matrix is 250 Codex runs
(`10 cases × 5 variants × 5 trials`) and is unnecessarily expensive at this stage.
Prefer:

```bash
# Critical adversarial case, five trials
bun run benchmark:retrieval-policy -- \
  --variants host-policy \
  --case adversarial/stale-confirmation \
  --trials 5 \
  --output docs/research/retrieval-policy-host-stale-n5.json

# Missing-commit clarification, five trials
bun run benchmark:retrieval-policy -- \
  --variants host-policy \
  --case clarify/missing-commit \
  --trials 5 \
  --output docs/research/retrieval-policy-host-clarify-n5.json
```

Ask before running these. A lean OpenAI Responses API runner would be preferable to
Codex exec if an explicit benchmark API key is provided.

## Suggested Claude prompt

```text
Read AGENTS.md, CONTEXT.md, and
docs/handoffs/retrieval-grounding-handoff-2026-08-15.md completely.

Continue the Retrieval Grounding + Joint Memory/Code work from the current dirty
worktree. Preserve all unrelated changes; do not reset or checkout files.

First review the scoped patch and run the P0 validation commands in the handoff.
Fix only defects introduced by the grounding patch. Then report:
1. whether the required/auto/off host gate is correct and sufficiently deep;
2. whether the MCP trigger contract is clear to models;
3. whether the benchmark scores invocation separately from answer quality;
4. the exact host integration seam still missing.

Do not run paid/live GPT benchmarks without asking. Do not modify the underlying
Memory or Code retrievers unless a new failing benchmark proves that layer is the
cause.
```
