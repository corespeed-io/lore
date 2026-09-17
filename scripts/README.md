# Development and operations scripts

Run supported commands from the repository root with `bun run <command>`.
The command names in [package.json](../package.json) are the public entrypoints;
helpers and colocated tests support those commands.

| Directory | Purpose | Commands |
| --- | --- | --- |
| [`build/`](build/) | Package verification and the dbmate binary used by self-host deployments | `build:dbmate`, `packages:smoke` |
| [`checks/`](checks/) | Design rules, real PostgreSQL product smoke, and Python SDK tests | `design:check`, `smoke:memory-core`, `test:python` |
| [`database/`](database/) | Migrations, runtime roles, backup/restore, recovery checks, and embedding generation administration | `db:migrate`, `db:preflight`, `db:bootstrap`, `db:backup`, `db:restore`, `db:pitr:check`, `db:embedding:report`, `db:embedding:activate` |
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
