# Development and operations scripts

Run supported commands from the repository root with `bun run <command>`.
The command names in [package.json](../package.json) are the public entrypoints;
helpers and colocated tests support those commands.

Handwritten scripts are TypeScript. `bun run typecheck` checks the application and
the scripts: [`tsconfig.json`](tsconfig.json) uses Bun types with ESNext/bundler
resolution, checked array access, exact optional properties, and erasable syntax.
Use explicit `.ts` extensions and `import type` in these scripts. The Memory Core
smoke and embedding administration scripts import application modules and are
checked by the root application configuration instead.

Bun runs all TypeScript tooling, including the local service manager, database
commands, package builds, and checks. Credential-sensitive entrypoints use
`--no-env-file`; the local manager loads its configured environment explicitly
and gives each child only that process's database credential. CLI/MCP binaries
also disable automatic `.env` loading.

| Directory | Purpose | Commands |
| --- | --- | --- |
| [`build/`](build/) | Package verification and the dbmate binary used by self-host deployments | `build:dbmate`, `packages:smoke` |
| [`checks/`](checks/) | Design rules, PostgreSQL and Bun/Next HTTP smoke | `design:check`, `smoke:memory-core`, `smoke:next` |
| [`database/`](database/) | Migrations, runtime roles, backup/restore, recovery checks, and embedding generation administration | `db:migrate`, `db:preflight`, `db:bootstrap`, `db:backup`, `db:restore`, `db:pitr:check`, `db:embedding:report`, `db:embedding:activate`, `db:embedding:requeue-dead` |
| [`dev/`](dev/) | Native local-service lifecycle and its tests | `service:up`, `service:down`, `service:restart`, `service:status`, `service:logs`, `service:test` |

Setup and arguments live in the [technical reference](../docs/reference.md),
including [local development](../docs/reference.md#local-development) and
[verification](../docs/reference.md#verify-changes). Database procedures and the
disposable-database smoke requirements live in the
[operations guide](../docs/operations.md).

Manual benchmarks and evaluation harnesses live in
[`tools/evaluation/`](../tools/evaluation/README.md). They are excluded from the
runtime image; this directory retains build, verification, development, and
database operations tooling.
