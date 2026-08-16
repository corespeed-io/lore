# Joint Memory + Code real-Git v5 baseline

Date: 2026-08-14

`joint-memory-code-real-git-v5` promotes the evaluated joint retrieval policy to
the public production seam:

- `POST /api/v1/context/retrieve`;
- TypeScript `workspace.retrieveContext(...)`;
- Python `workspace.retrieve_context(...)`;
- read-only MCP `lore_retrieve_context`.

The original question controls routing. Optional bounded `memoryQuery` and
`codeQuery` are channel-specific agent plans and are echoed in the receipt. Code
still requires one operator repository key and an exact full commit OID. Attached
Memory Code Evidence is assessed without persisted revalidation. When an
assessment resolves a current Artifact that direct Code search missed, the exact
Artifact is fetched by id from the same active revision/generation and receives
priority inside the configured Code budget.

## Strict real-Git result

The six-case adjacent-commit suite passed with the isolated GPT-5.6 reader:

- route accuracy: `1.0`;
- Memory recall: `1.0`;
- Code recall: `1.0`;
- anchor-state accuracy: `1.0`;
- selective reader pass rate: `1.0`;
- public production-context gate: `6/6`;
- side-effect-free assessment gate: passed.

The always-on union remained worse: reader pass rate `0.667`, code recall `0.833`,
and route accuracy `0.5`. This continues to support selective composition rather
than unconditional Memory injection.

The adversarial production gate initially failed `change/rejected-retention`:
`codeQuery="30 days"` did not directly retrieve the cited current Artifact even
though anchor assessment had resolved its exact id. Adding exact-revision anchored
Artifact expansion changed that gate from fail to pass without increasing the
public Code limit or mutating the citation.

## Honest limitation

Local anchor assessment is implemented. Dependency-graph contextual impact is not
yet computed by the public v1 orchestration. When the route requires it, the packet
reports `contextualImpact.state="unknown"`, records `not_assessed`, and adds an
explicit conflict instead of silently claiming no impact.

Reproduction:

```bash
bun run evaluate:joint-memory-code:real -- \
  --strict \
  --reader-provider codex \
  --model gpt-5.6-sol \
  --database /path/to/an/initialized/evaluation-pglite-directory \
  --output /tmp/joint-memory-code-real-git-v5-gpt56.json
```
