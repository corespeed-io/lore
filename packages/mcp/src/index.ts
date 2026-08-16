import {
  type CiteMemoryCodeEvidenceInput,
  type CodeArtifact,
  type CodeDependencyQueryInput,
  type CodeDependencyQueryResult,
  type CodeIndexJob,
  type CodeSearchInput,
  type CreateMemoryInput,
  type CreateMemoryProposalInput,
  type EnqueueCodeIndexInput,
  type Episode,
  LoreApiError,
  LoreClient,
  loreConfigurationFromEnvironment,
  type Memory,
  type MemoryCodeEvidence,
  type MemoryPage,
  type MemoryProposal,
  type MemorySearchInput,
  type MemorySearchResult,
  type MutationOptions,
  type RecordEpisodeInput,
  type RetrieveContextInput,
  type RetrievedContext,
  type RevalidateMemoryCodeEvidenceInput,
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
  code: LoreMcpCodeClient;
  context: LoreMcpContextClient;
}

export interface LoreMcpContextClient {
  retrieveContext(input: RetrieveContextInput): Promise<RetrievedContext>;
}

export type LoreMcpRetrieveContextInput = RetrieveContextInput;
export type LoreMcpRetrievedContext = RetrievedContext;

export interface LoreMcpCodeClient {
  searchCode(input: CodeSearchInput): Promise<readonly CodeArtifact[]>;
  queryCodeDependencies(input: CodeDependencyQueryInput): Promise<CodeDependencyQueryResult>;
  enqueueCodeIndex(input: EnqueueCodeIndexInput, signal?: AbortSignal): Promise<CodeIndexJob>;
  getCodeIndexJob(jobId: string, signal?: AbortSignal): Promise<CodeIndexJob>;
  listMemoryCodeEvidence(
    memoryId: string,
    signal?: AbortSignal,
  ): Promise<readonly MemoryCodeEvidence[]>;
  citeMemoryCodeEvidence(
    memoryId: string,
    input: CiteMemoryCodeEvidenceInput,
    signal?: AbortSignal,
  ): Promise<MemoryCodeEvidence>;
  revalidateMemoryCodeEvidence(
    evidenceId: string,
    input: RevalidateMemoryCodeEvidenceInput,
    signal?: AbortSignal,
  ): Promise<MemoryCodeEvidence>;
}

const scopeSchema = z.enum(["shared", "private"]);
const MAX_MEMORY_CONTENT_CHARACTERS = 32_000;
const MAX_METADATA_CHARACTERS = 100_000;
const MAX_METADATA_DEPTH = 32;
const MAX_METADATA_VALUES = 10_000;
const MAX_MCP_OUTPUT_CHARACTERS = 128_000;
const LIST_CONTENT_BUDGET = 2_800;
const SEARCH_EVIDENCE_BUDGET = 2_800;
const SUMMARY_METADATA_BUDGET = 900;
const DETAIL_CONTENT_BUDGET = 96_000;
const DETAIL_METADATA_BUDGET = 16_000;
const CODE_ARTIFACT_CONTENT_BUDGET = 8_000;

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
const memoryContentSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MEMORY_CONTENT_CHARACTERS * 2)
  .refine((content) => Array.from(content).length <= MAX_MEMORY_CONTENT_CHARACTERS, {
    message: `Memory content may contain at most ${MAX_MEMORY_CONTENT_CHARACTERS} Unicode characters`,
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
const codeEvidenceRelationshipSchema = z.enum([
  "supports",
  "contradicts",
  "implements",
  "rationale",
]);
const proposalCodeEvidenceInputSchema = z.object({
  artifactId: z.string().uuid(),
  relationship: codeEvidenceRelationshipSchema,
});
const proposalCodeEvidenceSchema = z.object({
  ordinal: z.number().int().min(0).max(49),
  repositoryId: z.string().uuid(),
  citedRevisionId: z.string().uuid(),
  citedGenerationId: z.string().uuid(),
  citedArtifactId: z.string().uuid(),
  citedCommitOid: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
  citedPath: z.string().min(1).max(1024),
  citedSymbolKey: z.string().nullable(),
  citedDeclarationKey: z.string().nullable(),
  citedDeclarationChunkOrdinal: z.number().int().min(0).nullable(),
  citedDeclarationContextSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  citedContentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  relationship: codeEvidenceRelationshipSchema,
});
const proposalSubmissionSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["create", "update"]),
  targetMemoryId: z.string().uuid().nullable(),
  baseMemoryVersion: z.number().int().positive().nullable(),
  proposedScope: scopeSchema,
  evidenceMemoryIds: z.array(z.string().uuid()).max(50),
  evidenceObservationIds: z.array(z.string().uuid()).max(50),
  codeEvidence: z.array(proposalCodeEvidenceSchema).max(50),
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
    codeEvidence: proposal.codeEvidence.map((evidence) => ({ ...evidence })),
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
        content: memoryContentSchema,
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
          const metadataCharacters = input.observations.reduce(
            (total, observation) => total + JSON.stringify(observation.metadata ?? {}).length,
            0,
          );
          if (metadataCharacters > 1_000_000) {
            context.addIssue({
              code: "custom",
              message: "Episode metadata exceeds 1000000 characters",
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
            content: memoryContentSchema,
            scope: scopeSchema.default("shared"),
            metadata: metadataSchema.optional(),
            evidenceMemoryIds: z.array(z.string().uuid()).max(50).optional(),
            evidenceObservationIds: z.array(z.string().uuid()).max(50).optional(),
            codeEvidence: z.array(proposalCodeEvidenceInputSchema).max(50).optional(),
            idempotencyKey: idempotencyKeySchema,
          })
          .refine(
            (input) =>
              (input.evidenceMemoryIds?.length ?? 0) +
                (input.evidenceObservationIds?.length ?? 0) <=
              50 - (input.codeEvidence?.length ?? 0),
            { message: "proposal evidence exceeds 50 items" },
          ),
        z
          .object({
            kind: z.literal("update"),
            targetMemoryId: z.string().uuid(),
            expectedVersion: z.number().int().positive(),
            content: memoryContentSchema.optional(),
            scope: scopeSchema.optional(),
            metadata: metadataSchema.optional(),
            evidenceMemoryIds: z.array(z.string().uuid()).max(50).optional(),
            evidenceObservationIds: z.array(z.string().uuid()).max(50).optional(),
            codeEvidence: z.array(proposalCodeEvidenceInputSchema).max(50).optional(),
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
              50 - (input.codeEvidence?.length ?? 0),
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
          content: memoryContentSchema.optional(),
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

function registerCodeTools(server: McpServer, code: LoreMcpCodeClient): void {
  const commitOidSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
  const evidenceSchema = z.object({
    id: z.string().uuid(),
    memoryId: z.string().uuid(),
    citedCommitOid: commitOidSchema,
    citedPath: z.string(),
    relationship: z.enum(["supports", "contradicts", "implements", "rationale"]),
    validationState: z.enum([
      "current",
      "moved",
      "changed",
      "deleted",
      "ambiguous",
      "unverifiable",
    ]),
    validatedCommitOid: commitOidSchema.nullable(),
    validatedPath: z.string().nullable(),
  });
  const codeLocatorSchema = z.object({
    artifactId: z.string().uuid().nullable(),
    path: z.string().nullable(),
    symbol: z.string().nullable(),
    symbolKey: z.string().nullable(),
  });
  const dependencyEdgeSchema = z.object({
    id: z.string().uuid(),
    kind: z.enum(["calls", "imports", "references"]),
    resolution: z.enum(["resolved", "ambiguous", "unresolved"]),
    targetText: z.string(),
    from: codeLocatorSchema,
    to: codeLocatorSchema,
    site: z.object({
      path: z.string(),
      startLine: z.number().int().positive(),
      startColumn: z.number().int().nonnegative(),
      endLine: z.number().int().positive(),
      endColumn: z.number().int().nonnegative(),
    }),
  });
  server.registerTool(
    "lore_code_search",
    {
      title: "Search Lore Code Index",
      description:
        "Search RLS-visible Code Artifacts from one configured repository and exact full commit OID. Code Evidence is separate from canonical Memory.",
      inputSchema: z.object({
        repositoryKey: z.string().trim().min(1).max(512),
        commitOid: commitOidSchema,
        query: z.string().trim().min(1).max(2_000),
        limit: z.number().int().min(1).max(25).default(10),
        pathPrefix: z.string().trim().min(1).max(1_024).optional(),
      }),
      outputSchema: z.object({
        artifacts: z.array(
          z.object({
            id: z.string().uuid(),
            commitOid: commitOidSchema,
            path: z.string(),
            language: z.string(),
            kind: z.string(),
            symbol: z.string().nullable(),
            startLine: z.number().int(),
            endLine: z.number().int(),
            matchedChannels: z.array(z.enum(["symbol", "literal", "lexical", "path"])),
            score: z.number(),
            content: z.string(),
            contentTruncated: z.boolean(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const artifacts = await code.searchCode(input);
        return success({
          artifacts: artifacts.map((artifact) => {
            const content = boundedString(artifact.content, CODE_ARTIFACT_CONTENT_BUDGET);
            return {
              id: artifact.id,
              commitOid: artifact.commitOid,
              path: artifact.path,
              language: artifact.language,
              kind: artifact.kind,
              symbol: artifact.symbol,
              startLine: artifact.startLine,
              endLine: artifact.endLine,
              matchedChannels: [...artifact.matchedChannels],
              score: artifact.score,
              content: content.value,
              contentTruncated: content.truncated,
            };
          }),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "lore_code_dependencies",
    {
      title: "Query Lore Code Dependencies",
      description:
        "Return bounded callers or callees for exactly one symbol or path from an RLS-visible repository and exact full commit OID. Ambiguous and unresolved static-analysis targets remain explicit.",
      inputSchema: z
        .object({
          repositoryKey: z.string().trim().min(1).max(512),
          commitOid: commitOidSchema,
          direction: z.enum(["callers", "callees"]),
          symbol: z.string().trim().min(1).max(1_600).optional(),
          path: z.string().trim().min(1).max(1_024).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .refine((input) => (input.symbol === undefined) !== (input.path === undefined), {
          message: "Provide exactly one of symbol or path",
        }),
      outputSchema: z.object({
        status: z.enum(["ok", "ambiguous", "not_found"]),
        repositoryKey: z.string(),
        commitOid: commitOidSchema,
        direction: z.enum(["callers", "callees"]),
        subject: codeLocatorSchema.optional(),
        edges: z.array(dependencyEdgeSchema).max(200).optional(),
        truncated: z.boolean().optional(),
        candidates: z.array(codeLocatorSchema).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const result = await code.queryCodeDependencies(input);
        return success({ ...result });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "lore_code_index",
    {
      title: "Queue Lore Code Index",
      description:
        "Queue one exact commit from an operator-configured repository. The tool accepts a repository key, never a filesystem path or remote credential.",
      inputSchema: z.object({
        repositoryKey: z.string().trim().min(1).max(512),
        commitOid: commitOidSchema,
        sourceRef: z.string().trim().min(1).max(512).optional(),
      }),
      outputSchema: z.object({
        job: z.object({
          id: z.string().uuid(),
          repositoryKey: z.string(),
          commitOid: commitOidSchema,
          status: z.enum(["pending", "processing", "succeeded", "dead", "cancelled"]),
        }),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        const job = await code.enqueueCodeIndex(input);
        return success({
          job: {
            id: job.id,
            repositoryKey: job.repositoryKey,
            commitOid: job.commitOid,
            status: job.status,
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "lore_code_index_status",
    {
      title: "Get Lore Code Index Status",
      description:
        "Read safe status for one already-enqueued Code Index job. Local repository paths and credentials are never returned.",
      inputSchema: z.object({ jobId: z.string().uuid() }),
      outputSchema: z.object({
        job: z.object({
          id: z.string().uuid(),
          repositoryKey: z.string(),
          commitOid: commitOidSchema,
          indexerRevision: z.string(),
          status: z.enum(["pending", "processing", "succeeded", "dead", "cancelled"]),
          attemptCount: z.number().int(),
          maximumAttempts: z.number().int(),
          lastError: z.string().nullable(),
        }),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ jobId }) => {
      try {
        const job = await code.getCodeIndexJob(jobId);
        return success({
          job: {
            id: job.id,
            repositoryKey: job.repositoryKey,
            commitOid: job.commitOid,
            indexerRevision: job.indexerRevision,
            status: job.status,
            attemptCount: job.attemptCount,
            maximumAttempts: job.maximumAttempts,
            lastError: job.lastError,
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "lore_code_evidence_list",
    {
      title: "List Memory Code Evidence",
      description: "List typed, revision-bound Code Evidence visible with one Memory.",
      inputSchema: z.object({ memoryId: z.string().uuid() }),
      outputSchema: z.object({ evidence: z.array(evidenceSchema) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ memoryId }) => {
      try {
        return success({
          evidence: (await code.listMemoryCodeEvidence(memoryId)).map((item) => ({
            id: item.id,
            memoryId: item.memoryId,
            citedCommitOid: item.citedCommitOid,
            citedPath: item.citedPath,
            relationship: item.relationship,
            validationState: item.validationState,
            validatedCommitOid: item.validatedCommitOid,
            validatedPath: item.validatedPath,
          })),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "lore_code_evidence_cite",
    {
      title: "Cite Code Evidence for a Memory",
      description:
        "Attach one visible active Code Artifact as immutable evidence for an owner-writable Memory. This never changes Memory content.",
      inputSchema: z.object({
        memoryId: z.string().uuid(),
        artifactId: z.string().uuid(),
        relationship: z.enum(["supports", "contradicts", "implements", "rationale"]),
      }),
      outputSchema: z.object({ evidence: evidenceSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ memoryId, artifactId, relationship }) => {
      try {
        const item = await code.citeMemoryCodeEvidence(memoryId, { artifactId, relationship });
        return success({
          evidence: {
            id: item.id,
            memoryId: item.memoryId,
            citedCommitOid: item.citedCommitOid,
            citedPath: item.citedPath,
            relationship: item.relationship,
            validationState: item.validationState,
            validatedCommitOid: item.validatedCommitOid,
            validatedPath: item.validatedPath,
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "lore_code_evidence_revalidate",
    {
      title: "Revalidate Memory Code Evidence",
      description:
        "Re-resolve one citation against an explicitly selected exact commit. Updates only evidence validity; never rewrites canonical Memory.",
      inputSchema: z.object({
        evidenceId: z.string().uuid(),
        repositoryKey: z.string().trim().min(1).max(512),
        commitOid: commitOidSchema,
      }),
      outputSchema: z.object({ evidence: evidenceSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ evidenceId, repositoryKey, commitOid }) => {
      try {
        const item = await code.revalidateMemoryCodeEvidence(evidenceId, {
          repositoryKey,
          commitOid,
        });
        return success({
          evidence: {
            id: item.id,
            memoryId: item.memoryId,
            citedCommitOid: item.citedCommitOid,
            citedPath: item.citedPath,
            relationship: item.relationship,
            validationState: item.validationState,
            validatedCommitOid: item.validatedCommitOid,
            validatedPath: item.validatedPath,
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
}

function registerContextTools(server: McpServer, context: LoreMcpContextClient): void {
  const commitOidSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
  const routeSchema = z.enum(["auto", "both", "code-only", "memory-only"]);
  const deliveredRouteSchema = z.enum(["abstain", "both", "code-only", "memory-only"]);
  const validationStateSchema = z.enum([
    "current",
    "moved",
    "changed",
    "deleted",
    "ambiguous",
    "unverifiable",
  ]);
  server.registerTool(
    "lore_retrieve_context",
    {
      title: "Retrieve Lore Context",
      description:
        "Use this tool before answering when correctness depends on prior Workspace decisions, user-specific facts, current repository behavior, or exact-revision Code Index evidence. For a historical-decision versus current-Code question, retrieve both evidence families. Code requires an operator-configured repository key plus a full commit OID; if that exact revision is unavailable, ask for it instead of guessing or searching Memory as a substitute. Do not use it for transformations fully supported by supplied text, general knowledge, or unconstrained brainstorming. Returns one bounded, provenance-bearing packet from independently authorized Memory and Code evidence; Code Evidence assessment is side-effect-free.",
      inputSchema: z
        .object({
          query: z.string().trim().min(1).max(10_000),
          memoryQuery: z.string().trim().min(1).max(10_000).optional(),
          codeQuery: z.string().trim().min(1).max(2_000).optional(),
          repositoryKey: z.string().trim().min(1).max(512).optional(),
          commitOid: commitOidSchema.optional(),
          route: routeSchema.optional(),
          memoryLimit: z.number().int().min(1).max(10).optional(),
          codeLimit: z.number().int().min(1).max(20).optional(),
          scope: scopeSchema.optional(),
          metadata: metadataSchema.optional(),
          pathPrefix: z.string().trim().min(1).max(1_024).optional(),
        })
        .superRefine((input, refinement) => {
          if ((input.repositoryKey === undefined) !== (input.commitOid === undefined)) {
            refinement.addIssue({
              code: "custom",
              message: "repositoryKey and commitOid must be provided together",
            });
          }
          if (
            (input.route === "both" || input.route === "code-only") &&
            input.repositoryKey === undefined
          ) {
            refinement.addIssue({
              code: "custom",
              message: `${input.route} requires repositoryKey and commitOid`,
            });
          }
          if (input.pathPrefix !== undefined && input.repositoryKey === undefined) {
            refinement.addIssue({
              code: "custom",
              message: "pathPrefix requires repositoryKey and commitOid",
            });
          }
          if (input.codeQuery !== undefined && input.repositoryKey === undefined) {
            refinement.addIssue({
              code: "custom",
              message: "codeQuery requires repositoryKey and commitOid",
            });
          }
        }),
      outputSchema: z.object({
        revision: z.string(),
        query: z.string(),
        plan: z.object({
          intent: z.enum([
            "blast-radius",
            "change",
            "current-code",
            "memory-recall",
            "rationale",
            "unknown",
          ]),
          route: deliveredRouteSchema,
          needsAnchorExpansion: z.boolean(),
          needsContextualImpact: z.boolean(),
          needsLocalAssessment: z.boolean(),
          reasons: z.array(z.string()),
        }),
        deliveredRoute: deliveredRouteSchema,
        memories: z.array(
          z.object({
            id: z.string().uuid(),
            scope: scopeSchema,
            updatedAt: z.string(),
            score: z.number(),
            rerankScore: z.number().min(0).max(1).optional(),
            evidence: z.string(),
            evidenceTruncated: z.boolean(),
          }),
        ),
        code: z.array(
          z.object({
            artifactId: z.string().uuid(),
            commitOid: commitOidSchema,
            path: z.string(),
            symbol: z.string().nullable(),
            startLine: z.number().int().positive(),
            endLine: z.number().int().positive(),
            score: z.number(),
            matchedChannels: z.array(z.enum(["symbol", "literal", "lexical", "path"])),
            content: z.string(),
            contentTruncated: z.boolean(),
          }),
        ),
        anchors: z.array(
          z.object({
            id: z.string().uuid(),
            memoryId: z.string().uuid(),
            relationship: codeEvidenceRelationshipSchema,
            localState: validationStateSchema,
            citedCommitOid: commitOidSchema,
            citedPath: z.string(),
            validatedCommitOid: commitOidSchema.nullable(),
            validatedPath: z.string().nullable(),
          }),
        ),
        conflicts: z.array(z.string()),
        receipt: z.object({
          memoryCandidates: z.number().int().nonnegative(),
          codeCandidates: z.number().int().nonnegative(),
          anchorCandidates: z.number().int().nonnegative(),
          requestedCommitOid: commitOidSchema.nullable(),
          memoryQuery: z.string().nullable(),
          codeQuery: z.string().nullable(),
          contextualImpact: z
            .object({
              state: z.enum(["affected", "possibly_affected", "unaffected", "unknown"]),
              changes: z.array(z.string()),
            })
            .nullable(),
        }),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const packet = await context.retrieveContext(input);
        return success({
          ...packet,
          memories: packet.memories.map((memory) => {
            const evidence = boundedString(memory.evidence, SEARCH_EVIDENCE_BUDGET);
            return {
              ...memory,
              evidence: evidence.value,
              evidenceTruncated: evidence.truncated,
            };
          }),
          code: packet.code.map((artifact) => {
            const content = boundedString(artifact.content, CODE_ARTIFACT_CONTENT_BUDGET);
            return {
              ...artifact,
              content: content.value,
              contentTruncated: content.truncated,
            };
          }),
        });
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
  registerContextTools(server, options.context);
  registerCodeTools(server, options.code);
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
  return serveStdio(() => createLoreMcpServer({ memories, code: memories, context: memories }));
}
