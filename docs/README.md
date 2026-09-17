# Lore documentation

## Current guides

| Goal | Guide |
| --- | --- |
| Run Lore locally | [Quick start](../README.md#quick-start) |
| Understand the product model | [Product vocabulary](../CONTEXT.md) |
| Find code and understand module boundaries | [Architecture](architecture.md) |
| Connect an application or agent | [Developer integration](developer-integration.md) |
| Configure providers, deployment, and benchmarks | [Technical reference](reference.md) |
| Operate, back up, restore, or migrate Lore | [Operations and portability](operations.md) |
| Work on the interface | [Design system](../DESIGN.md) |
| Contribute code | [Contributing](../.github/CONTRIBUTING.md) |
| Find development and database commands | [Script index](../scripts/README.md) |
| Run quality and performance measurements | [Evaluation tool index](../tools/evaluation/README.md) |

Package-specific setup lives with the [memory engine](../packages/lore-core/README.md),
[TypeScript SDK](../packages/typescript-sdk/README.md),
[CLI](../packages/cli/README.md), and
[MCP adapter](../packages/mcp/README.md).

## Architecture decisions

- [Deployment-level embedding configuration](adr/0001-deployment-embedding-configuration.md)
- [Observations before automatic Memory](adr/0002-observations-before-automatic-memory.md)
- [Bounded Memory, separate from raw documents](adr/0003-bounded-memory-not-document.md)
- [Reconstructable, versioned Memory chunks](adr/0004-reconstructable-versioned-memory-chunks.md)

## Research and evaluations

[Research index](research/README.md) lists retained source audits and benchmark
reports. Each report applies to its recorded date, revision, and workload; it does
not replace current setup instructions or establish a production performance guarantee.
Executable harnesses live in [`tools/evaluation/`](../tools/evaluation/README.md);
versioned suites and dataset manifests live in [`evaluation/`](../evaluation/).

Keep durable decisions and reproducible findings in documentation. Store individual
benchmark run artifacts in `evaluation/results`; remove superseded reports and
completed handoffs from the working tree. Their history remains in Git.
