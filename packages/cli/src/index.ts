import { parseArgs } from "node:util";
import {
  LoreApiError,
  LoreClient,
  type LoreClientOptions,
  loreConfigurationFromEnvironment,
  type MemoryScope,
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
  memory get <memory-id>
  memory update <memory-id> --version N [--content TEXT|--stdin] [--scope shared|private] [--metadata JSON] [--idempotency-key KEY]
  memory forget <memory-id> --version N [--idempotency-key KEY]
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
  LORE_ALLOW_INSECURE      Explicitly allow authenticated non-loopback HTTP

Secrets are intentionally accepted only through environment variables. Prefer
--stdin for private query or Memory content. Reuse --idempotency-key when retrying
a mutation after an unknown response outcome.
`;

class CliUsageError extends Error {
  override name = "CliUsageError";
}

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
  values: Readonly<Record<string, boolean | string | undefined>>,
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
        cursor: { type: "string" },
        help: { type: "boolean", short: "h" },
        "idempotency-key": { type: "string" },
        limit: { type: "string" },
        metadata: { type: "string" },
        offset: { type: "string" },
        pretty: { type: "boolean" },
        scope: { type: "string" },
        stdin: { type: "boolean" },
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
              ? await stdinValue(io, 1_000_000, "content")
              : requiredPosition(parsed.positionals, 2, "content"),
            scope: optionScope(parsed.values.scope),
            metadata: optionMetadata(parsed.values.metadata),
          },
          { idempotencyKey: parsed.values["idempotency-key"] },
        ),
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
          ? await stdinValue(io, 1_000_000, "content")
          : parsed.values.content,
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
