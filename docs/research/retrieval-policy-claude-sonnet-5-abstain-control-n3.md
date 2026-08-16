# Retrieval Policy Abstention Control — claude-sonnet-5 (N=3)

Grounding policy `retrieval-grounding-v3`; suite version 5. New case `abstain/insufficient-evidence` asks for a
decision (an Episode-evidence retention window) that the fixture deliberately does not contain;
the fixture was not modified for this case. Correct behavior is retrieve, then abstain without
stretching the unrelated human-only proposal decision into an answer.

| Variant | Pass | Behavior |
|---|---:|---|
| compound-auto | 3/3 | all trials retrieved (compound + specialist follow-ups), then abstained |
| host-policy | 3/3 | all trials retrieved (compound + specialist follow-ups), then abstained |

Total 6/6. Together with the fixture-v2 recheck this pins both directions:
answer when evidence suffices, abstain when it does not. These remain fixture-conditional
invocation/behavior results; retrieval quality on real corpora is measured separately
(`benchmark:retrieval`, real-backend E2E report).
