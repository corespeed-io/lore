# `@corespeed/lore-mcp`

External stdio Model Context Protocol adapter for Lore. It exposes bounded Memory
read and write tools, durable non-canonical `lore_observe` Episode recording, and
human-reviewed `lore_propose` submissions for one configured Actor and Workspace.
It delegates all access control to Lore/Postgres RLS and stores no Memory or
authorization state.

See the repository's [developer integration guide](https://github.com/corespeed-io/lore/blob/main/docs/developer-integration.md)
for secure configuration.
