# `@corespeed/lore-cli`

JSON command-line client for Lore, built on `@corespeed/lore-sdk`. Credentials are
accepted only through environment variables. Direct Memory commands and
human-reviewed `memory propose` submissions share the stable `/api/v1` contract.
`episode record --stdin` durably records raw evidence without exposing private
content in process arguments; run `lore --help` for the command surface.

See the repository's [developer integration guide](https://github.com/corespeed-io/lore/blob/main/docs/developer-integration.md)
for setup.
