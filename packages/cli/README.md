# `@corespeed/lore-cli`

JSON command-line client for Lore, built on `@corespeed/lore-sdk`. Credentials are
accepted only through environment variables. Direct Memory commands and
human-reviewed `memory propose` submissions share the stable `/api/v1` contract.
Proposal submissions may repeat `--code-evidence ARTIFACT_UUID:RELATIONSHIP`; the
relationship is `supports`, `contradicts`, `implements`, or `rationale`, and Code,
Memory, and Observation evidence share one 50-item limit.
`episode record --stdin` durably records raw evidence without exposing private
content in process arguments. `code dependencies callers|callees` queries one
exact repository commit and accepts exactly one symbol or repository-relative
source path; run `lore --help` for the command surface.

See the repository's [developer integration guide](https://github.com/corespeed-io/lore/blob/main/docs/developer-integration.md)
for setup.
