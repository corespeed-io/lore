import {
  type CreateMemoryInput,
  type CreateMemoryProposalInput,
  type Episode,
  LoreApiError,
  LoreClient,
  loreConfigurationFromEnvironment,
  type Memory,
  type MemoryPage,
  type MemoryProposal,
  type MemorySearchInput,
  type MemorySearchResult,
  type MutationOptions,
  type RecordEpisodeInput,
  type UpdateMemoryInput,
  type VersionedMutationOptions,
} from "@corespeed/lore-sdk";
import { McpServer } from "@modelcontextprotocol/server";
import { type StdioServerHandle, serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { LORE_MCP_VERSION } from "./generated/version.js";

export { LORE_MCP_VERSION };

export interface LoreMcpMemoryClient {
  recordEpisode(input: RecordEpisodeInput, options?: MutationOptions): Promise<Episode>;
  forgetMemory(memoryId: string, options: VersionedMutationOptions): Promise<void>;
  getMemory(memoryId: string, signal?: AbortSignal): Promise<Memory>;
  listMemories(input?: {
    limit?: number;
    cursor?: string;
    scope?: "shared" | "private";
  }): Promise<MemoryPage>;
  proposeMemory(
    input: CreateMemoryProposalInput,
    options?: MutationOptions,
  ): Promise<MemoryProposal>;
  remember(input: CreateMemoryInput, options?: MutationOptions): Promise<Memory>;
  searchMemories(input: MemorySearchInput): Promise<readonly MemorySearchResult[]>;
  updateMemory(
    memoryId: string,
    input: UpdateMemoryInput,
    options: VersionedMutationOptions,
  ): Promise<Memory>;
}

export interface LoreMcpServerOptions {
  memories: LoreMcpMemoryClient;
}

const scopeSchema = z.enum(["shared", "private"]);
const MAX_METADATA_CHARACTERS = 100_000;
const MAX_METADATA_DEPTH = 32;
const MAX_METADATA_VALUES = 10_000;
const MAX_MCP_OUTPUT_CHARACTERS = 128_000;
const LIST_CONTENT_BUDGET = 2_800;
const SEARCH_EVIDENCE_BUDGET = 2_800;
const SUMMARY_METADATA_BUDGET = 900;
const DETAIL_CONTENT_BUDGET = 96_000;
const DETAIL_METADATA_BUDGET = 16_000;

function metadataBoundaryError(value: Record<string, unknown>): string | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return "metadata must be JSON serializable";
  }
  if (serialized.length > MAX_METADATA_CHARACTERS) {
    return `metadata exceeds ${MAX_METADATA_CHARACTERS} characters`;
  }
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    visited += 1;
    if (visited > MAX_METADATA_VALUES) return `metadata exceeds ${MAX_METADATA_VALUES} values`;
    if (current.depth > MAX_METADATA_DEPTH) {
      return `metadata exceeds ${MAX_METADATA_DEPTH} levels`;
    }
    if (typeof current.value === "string" && current.value.includes("\0")) {
      return "metadata contains an invalid null character";
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        pending.push({ depth: current.depth + 1, value: item });
      }
    } else if (current.value && typeof current.value === "object") {
      for (const [key, item] of Object.entries(current.value)) {
        if (key.includes("\0")) return "metadata contains an invalid null character";
        pending.push({ depth: current.depth + 1, value: item });
      }
    }
  }
  return undefined;
}

const metadataSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  const message = metadataBoundaryError(value);
  if (message) context.addIssue({ code: "custom", message });
});
const idempotencyKeySchema = z.string().min(1).max(128).optional();
const memoryIdentitySchema = z.object({
  id: z.string().uuid(),
  scope: scopeSchema,
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const memorySummarySchema = memoryIdentitySchema.extend({
  metadata: metadataSchema,
  metadataTruncated: z.boolean(),
});
const memorySchema = memorySummarySchema.extend({
  content: z.string().max(DETAIL_CONTENT_BUDGET),
  contentTruncated: z.boolean(),
});
const searchResultSchema = z.object({
  memory: memorySummarySchema,
  score: z.number(),
  rerankScore: z.number().min(0).max(1).optional(),
  evidence: z.string().max(SEARCH_EVIDENCE_BUDGET),
  evidenceTruncated: z.boolean(),
});
const proposalSubmissionSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["create", "update"]),
  targetMemoryId: z.string().uuid().nullable(),
  baseMemoryVersion: z.number().int().positive().nullable(),
  proposedScope: scopeSchema,
  evidenceMemoryIds: z.array(z.string().uuid()).max(50),
  evidenceObservationIds: z.array(z.string().uuid()).max(50),
  status: z.enum(["pending", "accepted", "rejected"]),
  createdAt: z.string(),
});
const episodeSubmissionSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["conversation", "workflow", "document", "event"]),
  scope: scopeSchema,
  observations: z
    .array(
      z.object({
        id: z.string().uuid(),
        kind: z.enum(["message", "tool_call", "tool_result", "document_fragment", "event"]),
        observedAt: z.string(),
        payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1)
    .max(100),
  createdAt: z.string(),
});

type McpMemory = z.infer<typeof memorySchema>;
type McpMemorySummary = z.infer<typeof memorySummarySchema>;

function boundedString(
  value: string,
  jsonCharacterBudget: number,
): { truncated: boolean; value: string } {
  if (JSON.stringify(value).length <= jsonCharacterBudget) return { truncated: false, value };
  let low = 0;
  let high = Math.min(value.length, jsonCharacterBudget);
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (JSON.stringify(value.slice(0, midpoint)).length <= jsonCharacterBudget) low = midpoint;
    else high = midpoint - 1;
  }
  return { truncated: true, value: value.slice(0, low) };
}

function boundedMetadata(
  metadata: Record<string, unknown>,
  jsonCharacterBudget: number,
): { metadata: Record<string, unknown>; metadataTruncated: boolean } {
  const serialized = JSON.stringify(metadata);
  if (serialized.length <= jsonCharacterBudget) {
    return { metadata: { ...metadata }, metadataTruncated: false };
  }
  return { metadata: {}, metadataTruncated: true };
}

function mcpMemorySummary(memory: Memory, metadataBudget: number): McpMemorySummary {
  return {
    id: memory.id,
    scope: memory.scope,
    ...boundedMetadata(memory.metadata, metadataBudget),
    version: memory.version,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

function mcpMemory(memory: Memory, contentBudget: number, metadataBudget: number): McpMemory {
  const content = boundedString(memory.content, contentBudget);
  return {
    ...mcpMemorySummary(memory, metadataBudget),
    content: content.value,
    contentTruncated: content.truncated,
  };
}

function success(structuredContent: Record<string, unknown>) {
  const serialized = JSON.stringify(structuredContent);
  if (serialized.length > MAX_MCP_OUTPUT_CHARACTERS) {
    throw new TypeError(`Lore MCP output exceeds ${MAX_MCP_OUTPUT_CHARACTERS} characters`);
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `Lore returned structured output (${serialized.length} characters).`,
      },
    ],
    structuredContent,
  };
}

function failure(error: unknown) {
  const message =
    error instanceof LoreApiError
      ? `${error.code} (${error.status}): ${error.message}`
      : error instanceof TypeError
        ? error.message
        : "Lore request failed";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function mutationOptions(idempotencyKey: string | undefined): MutationOptions {
  return idempotencyKey === undefined ? {} : { idempotencyKey };
}

function versionedMutationOptions(
  expectedVersion: number,
  idempotencyKey: string | undefined,
): VersionedMutationOptions {
  return { expectedVersion, ...mutationOptions(idempotencyKey) };
}

function proposalSubmission(proposal: MemoryProposal): z.infer<typeof proposalSubmissionSchema> {
  return {
    id: proposal.id,
    kind: proposal.kind,
    targetMemoryId: proposal.targetMemoryId,
    baseMemoryVersion: proposal.baseMemoryVersion,
    proposedScope: proposal.proposedScope,
    evidenceMemoryIds: [...proposal.evidenceMemoryIds],
    evidenceObservationIds: [...proposal.evidenceObservationIds],
    status: proposal.status,
    createdAt: proposal.createdAt,
  };
}

function episodeSubmission(episode: Episode): z.infer<typeof episodeSubmissionSchema> {
  return {
    id: episode.id,
    kind: episode.kind,
    scope: episode.scope,
    observations: episode.observations.map((observation) => ({
      id: observation.id,
      kind: observation.kind,
      observedAt: observation.observedAt,
      payloadSha256: observation.payloadSha256,
    })),
    createdAt: episode.createdAt,
  };
}

function registerTools(server: McpServer, memories: LoreMcpMemoryClient): void {
  server.registerTool(
    "lore_list",
    {
      title: "List Lore Memories",
      description:
        "List Memories visible to the configured Lore Actor and Workspace. Content is a bounded preview; contentTruncated and metadataTruncated identify omitted data. Use the returned cursor to continue browsing.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(25).default(25),
        cursor: z.string().max(512).optional(),
        scope: scopeSchema.optional(),
      }),
      outputSchema: z.object({
        memories: z.array(memorySchema),
        nextCursor: z.string().nullable(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const page = await memories.listMemories(input);
        return success({
          memories: page.memories.map((memory) =>
            mcpMemory(memory, LIST_CONTENT_BUDGET, SUMMARY_METADATA_BUDGET),
          ),
          nextCursor: page.nextCursor,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "lore_search",
    {
      title: "Search Lore Memories",
      description:
        "Search only Memories visible to the configured Lore Actor and Workspace using Lore's authorized retrieval pipeline. Results return bounded evidence and Memory metadata, not redundant full Memory content.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(10_000),
        limit: z.number().int().min(1).max(25).default(10),
        scope: scopeSchema.optional(),
        metadata: metadataSchema.optional(),
      }),
      outputSchema: z.object({ results: z.array(searchResultSchema) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const results = await memories.searchMemories(input);
        return success({
          results: results.map((result) => {
            const evidence = boundedString(result.evidence, SEARCH_EVIDENCE_BUDGET);
            return {
              memory: mcpMemorySummary(result.memory, SUMMARY_METADATA_BUDGET),
              score: result.score,
              ...(result.rerankScore === undefined ? {} : { rerankScore: result.rerankScore }),
              evidence: evidence.value,
              evidenceTruncated: evidence.truncated,
            };
          }),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "lore_get",
    {
      title: "Get a Lore Memory",
      description:
        "Retrieve one visible Memory by id. Very large content or metadata is bounded for model safety and marked by contentTruncated or metadataTruncated. The returned version is required for safe update or forget operations.",
      inputSchema: z.object({ memoryId: z.string().uuid() }),
      outputSchema: z.object({ memory: memorySchema }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ memoryId }) => {
      try {
        return success({
          memory: mcpMemory(
            await memories.getMemory(memoryId),
            DETAIL_CONTENT_BUDGET,
            DETAIL_METADATA_BUDGET,
          ),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "lore_remember",
    {
      title: "Remember in Lore",
      description:
        "Create a Memory in the configured Workspace. Shared is the default; request private scope explicitly. Reuse idempotencyKey when retrying an unknown outcome.",
      inputSchema: z.object({
        content: z.string().trim().min(1).max(1_000_000),
        scope: scopeSchema.default("shared"),
        metadata: metadataSchema.optional(),
        idempotencyKey: idempotencyKeySchema,
      }),
      outputSchema: z.object({ memory: memorySchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        const { idempotencyKey, ...memoryInput } = input;
        return success({
          memory: mcpMemory(
            await memories.remember(memoryInput, mutationOptions(idempotencyKey)),
            DETAIL_CONTENT_BUDGET,
            DETAIL_METADATA_BUDGET,
          ),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "lore_observe",
    {
      title: "Record a Lore Episode",
      description:
        "Record an ordered Episode of durable, immutable Observation evidence. This does not create searchable Memory. Reuse idempotencyKey when retrying an unknown outcome.",
      inputSchema: z
        .object({
          kind: z.enum(["conversation", "workflow", "document", "event"]),
          scope: scopeSchema.default("private"),
          observations: z
            .array(
              z.object({
                kind: z.enum(["message", "tool_call", "tool_result", "document_fragment", "event"]),
                content: z
                  .string()
                  .min(1)
                  .max(100_000)
                  .refine((content) => content.trim().length > 0, {
                    message: "Observation content is required",
                  }),
                metadata: metadataSchema.optional(),
                observedAt: z.iso.datetime().optional(),
              }),
            )
            .min(1)
            .max(100),
          idempotencyKey: idempotencyKeySchema,
        })
        .superRefine((input, context) => {
          const characters = input.observations.reduce(
            (total, observation) => total + observation.content.length,
            0,
          );
          if (characters > 1_000_000) {
            context.addIssue({
              code: "custom",
              message: "Episode content exceeds 1000000 characters",
              path: ["observations"],
            });
          }
        }),
      outputSchema: z.object({ episode: episodeSubmissionSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        const { idempotencyKey, ...episodeInput } = input;
        return success({
          episode: episodeSubmission(
            await memories.recordEpisode(episodeInput, mutationOptions(idempotencyKey)),
          ),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "lore_propose",
    {
      title: "Propose a Lore Memory",
      description:
        "Submit an owner-private create or version-bound update proposal for human review. This does not create or change searchable Memory until the owner accepts it. Reuse idempotencyKey when retrying an unknown outcome.",
      inputSchema: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("create"),
            content: z.string().trim().min(1).max(1_000_000),
            scope: scopeSchema.default("shared"),
            metadata: metadataSchema.optional(),
            evidenceMemoryIds: z.array(z.string().uuid()).max(50).optional(),
            evidenceObservationIds: z.array(z.string().uuid()).max(50).optional(),
            idempotencyKey: idempotencyKeySchema,
          })
          .refine(
            (input) =>
              (input.evidenceMemoryIds?.length ?? 0) +
                (input.evidenceObservationIds?.length ?? 0) <=
              50,
            { message: "proposal evidence exceeds 50 items" },
          ),
        z
          .object({
            kind: z.literal("update"),
            targetMemoryId: z.string().uuid(),
            expectedVersion: z.number().int().positive(),
            content: z.string().trim().min(1).max(1_000_000).optional(),
            scope: scopeSchema.optional(),
            metadata: metadataSchema.optional(),
            evidenceMemoryIds: z.array(z.string().uuid()).max(50).optional(),
            evidenceObservationIds: z.array(z.string().uuid()).max(50).optional(),
            idempotencyKey: idempotencyKeySchema,
          })
          .refine(
            (input) =>
              input.content !== undefined ||
              input.scope !== undefined ||
              input.metadata !== undefined,
            { message: "content, scope, or metadata is required" },
          )
          .refine(
            (input) =>
              (input.evidenceMemoryIds?.length ?? 0) +
                (input.evidenceObservationIds?.length ?? 0) <=
              50,
            { message: "proposal evidence exceeds 50 items" },
          ),
      ]),
      outputSchema: z.object({ proposal: proposalSubmissionSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        const { idempotencyKey, ...proposalInput } = input;
        let normalizedProposal: CreateMemoryProposalInput;
        if (proposalInput.kind === "create") {
          normalizedProposal = proposalInput;
        } else if (proposalInput.content !== undefined) {
          normalizedProposal = { ...proposalInput, content: proposalInput.content };
        } else if (proposalInput.scope !== undefined) {
          normalizedProposal = { ...proposalInput, scope: proposalInput.scope };
        } else if (proposalInput.metadata !== undefined) {
          normalizedProposal = { ...proposalInput, metadata: proposalInput.metadata };
        } else {
          throw new TypeError("content, scope, or metadata is required");
        }
        return success({
          proposal: proposalSubmission(
            await memories.proposeMemory(normalizedProposal, mutationOptions(idempotencyKey)),
          ),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "lore_update",
    {
      title: "Update a Lore Memory",
      description:
        "Replace fields on one owned Memory using its current version. This may overwrite content, metadata, or visibility. Reuse idempotencyKey when retrying an unknown outcome.",
      inputSchema: z
        .object({
          memoryId: z.string().uuid(),
          version: z.number().int().positive(),
          content: z.string().trim().min(1).max(1_000_000).optional(),
          scope: scopeSchema.optional(),
          metadata: metadataSchema.optional(),
          idempotencyKey: idempotencyKeySchema,
        })
        .refine(
          (input) =>
            input.content !== undefined ||
            input.scope !== undefined ||
            input.metadata !== undefined,
          { message: "content, scope, or metadata is required" },
        ),
      outputSchema: z.object({ memory: memorySchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ memoryId, version, content, scope, metadata, idempotencyKey }) => {
      try {
        return success({
          memory: mcpMemory(
            await memories.updateMemory(
              memoryId,
              { content, scope, metadata },
              versionedMutationOptions(version, idempotencyKey),
            ),
            DETAIL_CONTENT_BUDGET,
            DETAIL_METADATA_BUDGET,
          ),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "lore_forget",
    {
      title: "Forget a Lore Memory",
      description:
        "Permanently delete one owned Memory using its current version. This is destructive and cannot be undone. Reuse idempotencyKey when retrying an unknown outcome.",
      inputSchema: z.object({
        memoryId: z.string().uuid(),
        version: z.number().int().positive(),
        idempotencyKey: idempotencyKeySchema,
      }),
      outputSchema: z.object({ deleted: z.literal(true) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ memoryId, version, idempotencyKey }) => {
      try {
        await memories.forgetMemory(memoryId, versionedMutationOptions(version, idempotencyKey));
        return success({ deleted: true });
      } catch (error) {
        return failure(error);
      }
    },
  );
}

export function createLoreMcpServer(options: LoreMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: "lore", version: LORE_MCP_VERSION },
    { capabilities: { tools: {} } },
  );
  registerTools(server, options.memories);
  return server;
}

export function serveLoreMcpStdio(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetchImplementation?: typeof globalThis.fetch,
): StdioServerHandle {
  const configuration = loreConfigurationFromEnvironment(environment);
  if (!configuration.workspaceId) {
    throw new TypeError("LORE_WORKSPACE_ID is required by the Lore MCP adapter");
  }
  const client = new LoreClient({ ...configuration.client, fetch: fetchImplementation });
  const memories = client.workspace(configuration.workspaceId);
  return serveStdio(() => createLoreMcpServer({ memories }));
}
