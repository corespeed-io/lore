# Joint Memory + Code real-Git v4 baseline

Date: 2026-08-14  
Revision: `joint-memory-code-real-git-v4`  
Reader: OpenAI `gpt-5.6-sol`, low reasoning effort  
Decision: **pass**

## Change under test

V4 moves joint retrieval from persistent Code Evidence revalidation to
side-effect-free assessment. A new release gate reloads every historical citation
after all ablation variants and compares its validation state, target locator, and
`validatedAt` with the pre-run snapshot. `sideEffectFreeAssessment` must be true.

Typed target consistency is also part of anchor-state accuracy:

- `current`, `moved`, and `changed` require the requested commit and a target path;
- `deleted` and `ambiguous` require the requested commit and a null target path;
- `unverifiable` requires both commit and path to be null.

## Commands

```bash
bun run evaluate:joint-memory-code:real -- \
  --database /tmp/lore-joint-memory-code-real-v3.PROTOTYPE.o994eB \
  --output /tmp/joint-memory-code-real-git-v4-no-reader.json \
  --no-reader --strict

bun run evaluate:joint-memory-code:real -- \
  --database /tmp/lore-joint-memory-code-real-v3.PROTOTYPE.o994eB \
  --output /tmp/joint-memory-code-real-git-v4-gpt56.json \
  --reader-provider codex \
  --model gpt-5.6-sol \
  --strict
```

The exact trusted Git corpus remains the v3 pair: 326 manifest entries in each
revision, 4,173 base Artifacts, and 4,177 target Artifacts.

## Result

| Variant | Route | Memory recall | Code recall | Anchor state | Reader pass | Avg reader evidence chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Code only | 50.0% | 50.0% | 83.3% | 0% | not run | 2,766 |
| Always-on Memory + Code | 50.0% | 100% | 83.3% | 0% | 66.7% (4/6) | 2,900 |
| Selective + typed assessment | 100% | 100% | 100% | 100% | 100% (6/6) | 3,239 |

All release gates passed, including `sideEffectFreeAssessment=true` and the fixed
reader. Independently provable anchors remain `current` or `changed`; both
structurally unstable submission-boundary anchors remain `ambiguous` with no target
path. The reader stays ephemeral, read-only, empty-directory, and evidence-only.

## Remaining falsification

- The real corpus is still six hand-authored cases from one adjacent commit pair.
- Scoring remains deterministic terms and citation shape, without an independent
  entailment judge.
- Production Postgres latency and the public joint MCP contract remain unevaluated.
