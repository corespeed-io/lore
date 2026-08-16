import { parseArgs } from "node:util";
import {
  type CreateMemoryProposalInput,
  LoreApiError,
  LoreClient,
  type LoreClientOptions,
  loreConfigurationFromEnvironment,
  type MemoryScope,
  type RecordEpisodeInput,
  type UpdateMemoryInput,
} from "@corespeed/lore-sdk";
import { LORE_CLI_VERSION } from "./generated/version.js";
import { readBoundedUtf8Stdin } from "./stdin.js";

export { LORE_CLI_VERSION };

export interface LoreCliIo {
  stdin(): Promise<string>;
  stderr(value: string): void;
  stdout(value: string): void;
}

export interface RunLoreCliOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  io?: LoreCliIo;
}

const HELP = `Lore CLI ${LORE_CLI_VERSION}

Usage:
  lore [--url URL] [--workspace UUID] [--pretty] <command>

Commands:
  workspace list
  workspace create <name>
  memory list [--limit N] [--cursor CURSOR] [--offset N] [--scope shared|private]
  memory search <query> [--limit N] [--scope shared|private]
  memory search --stdin [--limit N] [--scope shared|private]
  memory remember <content> [--scope shared|private] [--metadata JSON] [--idempotency-key KEY]
  memory remember --stdin [--scope shared|private] [--metadata JSON] [--idempotency-key KEY]
  memory propose create <content>|--stdin [--scope shared|private] [--metadata JSON] [--evidence UUID] [--observation-evidence UUID] [--code-evidence ARTIFACT_UUID:RELATIONSHIP] [--idempotency-key KEY]
  memory propose update <memory-id> --version N [--content TEXT|--stdin] [--scope shared|private] [--metadata JSON] [--evidence UUID] [--observation-evidence UUID] [--code-evidence ARTIFACT_UUID:RELATIONSHIP] [--idempotency-key KEY]
  memory get <memory-id>
  memory update <memory-id> --version N [--content TEXT|--stdin] [--scope shared|private] [--metadata JSON] [--idempotency-key KEY]
  memory forget <memory-id> --version N [--idempotency-key KEY]
  episode list [--limit N] [--cursor CURSOR] [--kind conversation|workflow|document|event] [--scope shared|private]
  episode record --stdin [--idempotency-key KEY]
  episode get <episode-id>
  episode forget <episode-id> [--idempotency-key KEY]
  code dependencies callers|callees --repository KEY --commit OID (--symbol SYMBOL|--path PATH) [--limit N]
  capabilities
  readiness

Connection environment:
  LORE_URL                 Default: http://127.0.0.1:3000
  LORE_WORKSPACE_ID        Default Workspace for scoped commands
  LORE_AGENT_TOKEN         Lore Agent bearer credential
  LORE_BASIC_PASSWORD      Single-operator password
  LORE_BASIC_USERNAME      Optional Basic username; default: lore
  LORE_ACCESS_TOKEN        Cloudflare Access gateway client token
  LORE_ACCESS_CLIENT_ID    Cloudflare Access gateway service-token client id
  LORE_ACCESS_CLIENT_SECRET  Cloudflare Access gateway service-token client secret
  LORE_REQUEST_TIMEOUT_MS  Total request deadline; default: 30000, max: 300000
  LORE_ALLOW_INSECURE      Explicitly allow authenticated non-loopback HTTP

Secrets are intentionally accepted only through environment variables. Prefer
--stdin for private query, Memory content, or Episode JSON. Reuse --idempotency-key when retrying
a mutation after an unknown response outcome.
`;

class CliUsageError extends Error {
  override name = "CliUsageError";
}

const MAX_MEMORY_CONTENT_CHARACTERS = 32_000;

function defaultIo(): LoreCliIo {
  return {
    stdin: () => readBoundedUtf8Stdin(process.stdin),
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  };
}

async function stdinValue(
  io: LoreCliIo,
  maximumLength: number,
  description: string,
): Promise<string> {
  const raw = await io.stdin();
  const value = raw.endsWith("\r\n")
    ? raw.slice(0, -2)
    : raw.endsWith("\n")
      ? raw.slice(0, -1)
      : raw;
  if (!value || value.length > maximumLength) {
    throw new CliUsageError(
      `${description} from stdin must contain 1 to ${maximumLength} characters`,
    );
  }
  return value;
}

function memoryContentValue(value: string): string {
  if (!value.trim()) {
    throw new CliUsageError("Memory content is required");
  }
  if (Array.from(value).length > MAX_MEMORY_CONTENT_CHARACTERS) {
    throw new CliUsageError(
      `Memory content may contain at most ${MAX_MEMORY_CONTENT_CHARACTERS} Unicode characters`,
    );
  }
  return value;
}

async function memoryContentFromStdin(io: LoreCliIo): Promise<string> {
  // stdin is already byte-bounded by readBoundedUtf8Stdin. Keep this first
  // bound loose so astral characters reach the code-point-aware public limit.
  return memoryContentValue(await stdinValue(io, 2_500_000, "content"));
}

function output(io: LoreCliIo, value: unknown, pretty: boolean): void {
  io.stdout(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}

function requiredPosition(positionals: string[], index: number, description: string): string {
  const value = positionals[index]?.trim();
  if (!value) throw new CliUsageError(`${description} is required`);
  return value;
}

function exactPositionals(positionals: string[], count: number, usage: string): void {
  if (positionals.length !== count) throw new CliUsageError(`Usage: lore ${usage}`);
}

function allowedOptions(
  values: Readonly<Record<string, boolean | string | readonly string[] | undefined>>,
  commandOptions: readonly string[],
): void {
  const permitted = new Set([
    "allow-insecure",
    "help",
    "pretty",
    "url",
    "workspace",
    ...commandOptions,
  ]);
  const unexpected = Object.entries(values).find(
    ([name, value]) => value !== undefined && !permitted.has(name),
  );
  if (unexpected) throw new CliUsageError(`--${unexpected[0]} is not valid for this command`);
}

function optionEvidence(
  values: readonly string[] | undefined,
  name = "--evidence",
): string[] | undefined {
  if (values === undefined) return undefined;
  if (values.length > 50) throw new CliUsageError(`${name} may be repeated at most 50 times`);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const normalized = values.map((value) => value.trim().toLowerCase());
  if (normalized.some((value) => !uuidPattern.test(value))) {
    throw new CliUsageError(`${name} must be a UUID`);
  }
  return [...new Set(normalized)];
}

function optionCodeEvidence(values: readonly string[] | undefined):
  | Array<{
      artifactId: string;
      relationship: "contradicts" | "implements" | "rationale" | "supports";
    }>
  | undefined {
  if (values === undefined) return undefined;
  if (values.length > 50) {
    throw new CliUsageError("--code-evidence may be repeated at most 50 times");
  }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const relationships = new Set(["contradicts", "implements", "rationale", "supports"]);
  const normalized = values.map((value) => {
    const [rawArtifactId, relationship, extra] = value.trim().toLowerCase().split(":");
    if (!rawArtifactId || !relationship || extra || !uuidPattern.test(rawArtifactId)) {
      throw new CliUsageError("--code-evidence must be ARTIFACT_UUID:RELATIONSHIP");
    }
    if (!relationships.has(relationship)) {
      throw new CliUsageError(
        "--code-evidence relationship must be supports, contradicts, implements, or rationale",
      );
    }
    return {
      artifactId: rawArtifactId,
      relationship: relationship as "contradicts" | "implements" | "rationale" | "supports",
    };
  });
  return [
    ...new Map(
      normalized.map((evidence) => [`${evidence.artifactId}:${evidence.relationship}`, evidence]),
    ).values(),
  ];
}

function episodeInput(value: string): RecordEpisodeInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CliUsageError("Episode stdin must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliUsageError("Episode stdin must be a JSON object");
  }
  return parsed as RecordEpisodeInput;
}

function optionInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new CliUsageError(`${name} must be an integer`);
  return parsed;
}

function optionScope(value: string | undefined): MemoryScope | undefined {
  if (value === undefined) return undefined;
  if (value === "shared" || value === "private") return value;
  throw new CliUsageError("--scope must be shared or private");
}

function optionMetadata(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CliUsageError("--metadata must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliUsageError("--metadata must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function scopedClient(
  client: LoreClient,
  workspaceId: string | undefined,
): ReturnType<LoreClient["workspace"]> {
  if (!workspaceId) {
    throw new CliUsageError("A Workspace is required; pass --workspace or set LORE_WORKSPACE_ID");
  }
  return client.workspace(workspaceId);
}

export async function runLoreCli(
  args: readonly string[],
  options: RunLoreCliOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIo();
  try {
    if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
      io.stdout(`${LORE_CLI_VERSION}\n`);
      return 0;
    }
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        "allow-insecure": { type: "boolean" },
        content: { type: "string" },
        commit: { type: "string" },
        "code-evidence": { type: "string", multiple: true },
        cursor: { type: "string" },
        evidence: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
        kind: { type: "string" },
        "idempotency-key": { type: "string" },
        limit: { type: "string" },
        metadata: { type: "string" },
        offset: { type: "string" },
        "observation-evidence": { type: "string", multiple: true },
        pretty: { type: "boolean" },
        path: { type: "string" },
        repository: { type: "string" },
        scope: { type: "string" },
        stdin: { type: "boolean" },
        symbol: { type: "string" },
        url: { type: "string" },
        version: { type: "string", short: "v" },
        workspace: { type: "string", short: "w" },
      },
    });
    if (parsed.values.help) {
      io.stdout(HELP);
      return 0;
    }
    if (parsed.positionals.length === 0 && parsed.values.version === undefined) {
      io.stdout(HELP);
      return 0;
    }

    const environment = options.environment ?? process.env;
    const configuration = loreConfigurationFromEnvironment(environment);
    const clientOptions: LoreClientOptions = {
      ...configuration.client,
      baseUrl: parsed.values.url ?? configuration.client.baseUrl,
      allowInsecure: parsed.values["allow-insecure"] === true || configuration.client.allowInsecure,
      fetch: options.fetch,
    };
    const workspaceId = parsed.values.workspace ?? configuration.workspaceId;
    const client = new LoreClient(clientOptions);
    const [group, action] = parsed.positionals;
    const pretty = parsed.values.pretty === true;

    if (group === "workspace" && action === "list") {
      exactPositionals(parsed.positionals, 2, "workspace list");
      allowedOptions(parsed.values, []);
      output(io, await client.listWorkspaces(), pretty);
      return 0;
    }
    if (group === "workspace" && action === "create") {
      exactPositionals(parsed.positionals, 3, "workspace create <name>");
      allowedOptions(parsed.values, []);
      output(
        io,
        await client.createWorkspace(requiredPosition(parsed.positionals, 2, "name")),
        pretty,
      );
      return 0;
    }
    if (group === "readiness" && action === undefined) {
      exactPositionals(parsed.positionals, 1, "readiness");
      allowedOptions(parsed.values, []);
      output(io, await client.readiness(), pretty);
      return 0;
    }

    const workspace = scopedClient(client, workspaceId);
    if (group === "capabilities" && action === undefined) {
      exactPositionals(parsed.positionals, 1, "capabilities");
      allowedOptions(parsed.values, []);
      output(io, await workspace.capabilities(), pretty);
      return 0;
    }
    if (group === "code" && action === "dependencies") {
      exactPositionals(
        parsed.positionals,
        3,
        "code dependencies callers|callees --repository KEY --commit OID (--symbol SYMBOL|--path PATH)",
      );
      allowedOptions(parsed.values, ["commit", "limit", "path", "repository", "symbol"]);
      const direction = parsed.positionals[2];
      if (direction !== "callers" && direction !== "callees") {
        throw new CliUsageError("Code Dependency direction must be callers or callees");
      }
      const repositoryKey = parsed.values.repository?.trim();
      const commitOid = parsed.values.commit?.trim();
      if (!repositoryKey) throw new CliUsageError("--repository is required");
      if (!commitOid) throw new CliUsageError("--commit is required");
      if ((parsed.values.symbol === undefined) === (parsed.values.path === undefined)) {
        throw new CliUsageError("Provide exactly one of --symbol or --path");
      }
      output(
        io,
        await workspace.queryCodeDependencies({
          repositoryKey,
          commitOid,
          direction,
          limit: optionInteger(parsed.values.limit, "--limit"),
          ...(parsed.values.symbol !== undefined
            ? { symbol: parsed.values.symbol }
            : { path: parsed.values.path }),
        }),
        pretty,
      );
      return 0;
    }
    if (group === "episode" && action === "list") {
      exactPositionals(parsed.positionals, 2, "episode list");
      allowedOptions(parsed.values, ["cursor", "kind", "limit", "scope"]);
      const kind = parsed.values.kind;
      if (
        kind !== undefined &&
        kind !== "conversation" &&
        kind !== "workflow" &&
        kind !== "document" &&
        kind !== "event"
      ) {
        throw new CliUsageError("--kind must be conversation, workflow, document, or event");
      }
      output(
        io,
        await workspace.listEpisodes({
          cursor: parsed.values.cursor,
          kind,
          limit: optionInteger(parsed.values.limit, "--limit"),
          scope: optionScope(parsed.values.scope),
        }),
        pretty,
      );
      return 0;
    }
    if (group === "episode" && action === "record") {
      exactPositionals(parsed.positionals, 2, "episode record --stdin");
      allowedOptions(parsed.values, ["idempotency-key", "stdin"]);
      if (parsed.values.stdin !== true) {
        throw new CliUsageError("episode record requires --stdin");
      }
      output(
        io,
        await workspace.recordEpisode(
          episodeInput(await stdinValue(io, 2_500_000, "Episode JSON")),
          { idempotencyKey: parsed.values["idempotency-key"] },
        ),
        pretty,
      );
      return 0;
    }
    if (group === "episode" && action === "get") {
      exactPositionals(parsed.positionals, 3, "episode get <episode-id>");
      allowedOptions(parsed.values, []);
      output(
        io,
        await workspace.getEpisode(requiredPosition(parsed.positionals, 2, "episode id")),
        pretty,
      );
      return 0;
    }
    if (group === "episode" && action === "forget") {
      exactPositionals(parsed.positionals, 3, "episode forget <episode-id>");
      allowedOptions(parsed.values, ["idempotency-key"]);
      await workspace.forgetEpisode(requiredPosition(parsed.positionals, 2, "episode id"), {
        idempotencyKey: parsed.values["idempotency-key"],
      });
      output(io, { deleted: true }, pretty);
      return 0;
    }
    if (group === "memory" && action === "list") {
      exactPositionals(parsed.positionals, 2, "memory list");
      allowedOptions(parsed.values, ["cursor", "limit", "metadata", "offset", "scope"]);
      output(
        io,
        await workspace.listMemories({
          cursor: parsed.values.cursor,
          limit: optionInteger(parsed.values.limit, "--limit"),
          offset: optionInteger(parsed.values.offset, "--offset"),
          scope: optionScope(parsed.values.scope),
          metadata: optionMetadata(parsed.values.metadata),
        }),
        pretty,
      );
      return 0;
    }
    if (group === "memory" && action === "search") {
      const fromStdin = parsed.values.stdin === true;
      exactPositionals(parsed.positionals, fromStdin ? 2 : 3, "memory search <query>|--stdin");
      allowedOptions(parsed.values, ["limit", "metadata", "scope", "stdin"]);
      output(
        io,
        await workspace.searchMemories({
          query: fromStdin
            ? await stdinValue(io, 10_000, "query")
            : requiredPosition(parsed.positionals, 2, "query"),
          limit: optionInteger(parsed.values.limit, "--limit"),
          scope: optionScope(parsed.values.scope),
          metadata: optionMetadata(parsed.values.metadata),
        }),
        pretty,
      );
      return 0;
    }
    if (group === "memory" && action === "remember") {
      const fromStdin = parsed.values.stdin === true;
      exactPositionals(parsed.positionals, fromStdin ? 2 : 3, "memory remember <content>|--stdin");
      allowedOptions(parsed.values, ["idempotency-key", "metadata", "scope", "stdin"]);
      output(
        io,
        await workspace.remember(
          {
            content: fromStdin
              ? await memoryContentFromStdin(io)
              : memoryContentValue(requiredPosition(parsed.positionals, 2, "content")),
            scope: optionScope(parsed.values.scope),
            metadata: optionMetadata(parsed.values.metadata),
          },
          { idempotencyKey: parsed.values["idempotency-key"] },
        ),
        pretty,
      );
      return 0;
    }
    if (group === "memory" && action === "propose") {
      const mode = parsed.positionals[2];
      const fromStdin = parsed.values.stdin === true;
      if (parsed.values.stdin && parsed.values.content !== undefined) {
        throw new CliUsageError("--stdin and --content cannot be combined");
      }
      let proposal: CreateMemoryProposalInput;
      if (mode === "create") {
        exactPositionals(
          parsed.positionals,
          fromStdin ? 3 : 4,
          "memory propose create <content>|--stdin",
        );
        allowedOptions(parsed.values, [
          "evidence",
          "code-evidence",
          "idempotency-key",
          "metadata",
          "observation-evidence",
          "scope",
          "stdin",
        ]);
        proposal = {
          kind: "create",
          content: fromStdin
            ? await memoryContentFromStdin(io)
            : memoryContentValue(requiredPosition(parsed.positionals, 3, "content")),
          scope: optionScope(parsed.values.scope),
          metadata: optionMetadata(parsed.values.metadata),
          evidenceMemoryIds: optionEvidence(parsed.values.evidence),
          evidenceObservationIds: optionEvidence(
            parsed.values["observation-evidence"],
            "--observation-evidence",
          ),
          codeEvidence: optionCodeEvidence(parsed.values["code-evidence"]),
        };
      } else if (mode === "update") {
        exactPositionals(parsed.positionals, 4, "memory propose update <memory-id> --version N");
        allowedOptions(parsed.values, [
          "content",
          "code-evidence",
          "evidence",
          "idempotency-key",
          "metadata",
          "observation-evidence",
          "scope",
          "stdin",
          "version",
        ]);
        const expectedVersion = optionInteger(parsed.values.version, "--version");
        if (expectedVersion === undefined) {
          throw new CliUsageError("memory propose update requires --version");
        }
        const updateBase = {
          kind: "update" as const,
          targetMemoryId: requiredPosition(parsed.positionals, 3, "memory id"),
          expectedVersion,
          evidenceMemoryIds: optionEvidence(parsed.values.evidence),
          evidenceObservationIds: optionEvidence(
            parsed.values["observation-evidence"],
            "--observation-evidence",
          ),
          codeEvidence: optionCodeEvidence(parsed.values["code-evidence"]),
        };
        const content = fromStdin
          ? await memoryContentFromStdin(io)
          : parsed.values.content === undefined
            ? undefined
            : memoryContentValue(parsed.values.content);
        const scope = optionScope(parsed.values.scope);
        const proposalMetadata = optionMetadata(parsed.values.metadata);
        if (content !== undefined) {
          proposal = { ...updateBase, content, scope, metadata: proposalMetadata };
        } else if (scope !== undefined) {
          proposal = { ...updateBase, scope, metadata: proposalMetadata };
        } else if (proposalMetadata !== undefined) {
          proposal = { ...updateBase, metadata: proposalMetadata };
        } else {
          throw new CliUsageError(
            "memory propose update requires --content, --scope, or --metadata",
          );
        }
      } else {
        throw new CliUsageError(
          "Usage: lore memory propose create <content>|--stdin, or memory propose update <memory-id> --version N",
        );
      }
      if (
        (proposal.evidenceMemoryIds?.length ?? 0) +
          (proposal.evidenceObservationIds?.length ?? 0) +
          (proposal.codeEvidence?.length ?? 0) >
        50
      ) {
        throw new CliUsageError("Proposal evidence may contain at most 50 total items");
      }
      output(
        io,
        await workspace.proposeMemory(proposal, {
          idempotencyKey: parsed.values["idempotency-key"],
        }),
        pretty,
      );
      return 0;
    }
    if (group === "memory" && action === "get") {
      exactPositionals(parsed.positionals, 3, "memory get <memory-id>");
      allowedOptions(parsed.values, []);
      output(
        io,
        await workspace.getMemory(requiredPosition(parsed.positionals, 2, "memory id")),
        pretty,
      );
      return 0;
    }
    if (group === "memory" && action === "update") {
      exactPositionals(parsed.positionals, 3, "memory update <memory-id> --version N");
      allowedOptions(parsed.values, [
        "content",
        "idempotency-key",
        "metadata",
        "scope",
        "stdin",
        "version",
      ]);
      if (parsed.values.stdin && parsed.values.content !== undefined) {
        throw new CliUsageError("--stdin and --content cannot be combined");
      }
      const update: UpdateMemoryInput = {
        content: parsed.values.stdin
          ? await memoryContentFromStdin(io)
          : parsed.values.content === undefined
            ? undefined
            : memoryContentValue(parsed.values.content),
        scope: optionScope(parsed.values.scope),
        metadata: optionMetadata(parsed.values.metadata),
      };
      if (Object.values(update).every((value) => value === undefined)) {
        throw new CliUsageError("memory update requires --content, --scope, or --metadata");
      }
      const expectedVersion = optionInteger(parsed.values.version, "--version");
      if (expectedVersion === undefined) {
        throw new CliUsageError("memory update requires --version");
      }
      output(
        io,
        await workspace.updateMemory(requiredPosition(parsed.positionals, 2, "memory id"), update, {
          expectedVersion,
          idempotencyKey: parsed.values["idempotency-key"],
        }),
        pretty,
      );
      return 0;
    }
    if (group === "memory" && action === "forget") {
      exactPositionals(parsed.positionals, 3, "memory forget <memory-id> --version N");
      allowedOptions(parsed.values, ["idempotency-key", "version"]);
      const expectedVersion = optionInteger(parsed.values.version, "--version");
      if (expectedVersion === undefined) {
        throw new CliUsageError("memory forget requires --version");
      }
      await workspace.forgetMemory(requiredPosition(parsed.positionals, 2, "memory id"), {
        expectedVersion,
        idempotencyKey: parsed.values["idempotency-key"],
      });
      output(io, { deleted: true }, pretty);
      return 0;
    }

    throw new CliUsageError(`Unknown command: ${parsed.positionals.join(" ")}`);
  } catch (error) {
    if (error instanceof LoreApiError) {
      io.stderr(`lore: ${error.code} (${error.status}): ${error.message}\n`);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`lore: ${message}\n`);
    return 2;
  }
}

export { HELP as LORE_CLI_HELP };
