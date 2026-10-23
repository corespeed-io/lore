import { fileURLToPath } from "node:url";
import { MEMORY_CHUNKING_REVISION } from "@corespeed/lore-core";
import { createMemoryModule } from "../../../src/modules/memories/service";
import { createGoogleEmbeddingProvider } from "../../../src/server/providers/embedding/google";
import { strictRetrievalKnobsFromEnvironment } from "../../../src/server/providers/retrieval-knobs";
import { cachedEmbeddingProvider } from "./embedding-cache";
import type { EvalStore } from "./store";
import {
  ALICE,
  BOB,
  EMBEDDING_SPACE,
  memoryCoverage,
  seedUnits,
  systemDatabases,
} from "./system-common";
import type { EvalCase, EvalSystem, EvalUnit, IngestOutcome, Packet, SystemContext } from "./types";

export { ALICE, BOB, EMBEDDING_SPACE } from "./system-common";

const THIS_FILE = fileURLToPath(import.meta.url);

/**
 * The shipped Memory path: every record becomes an Alice-private Memory through the
 * Memory module, with its occurredAt when the record states one, embeddings come from
 * leased maintenance, and each question is one Memory search with the deployment's
 * default knobs, limited to its Unit. Each passage carries its Memory's occurredAt,
 * as every search result does. Bob's private tripwires sit in the same Workspace; a
 * search that returns one fails.
 */
export function memorySearchSystem(options: {
  store: EvalStore;
  geminiApiKey: string;
  limit?: number;
}): EvalSystem {
  const limit = options.limit ?? 10;
  const { provider, counters } = cachedEmbeddingProvider(
    createGoogleEmbeddingProvider(EMBEDDING_SPACE, { apiKey: options.geminiApiKey, maxRetries: 5 }),
    options.store,
  );
  const knobs = strictRetrievalKnobsFromEnvironment({});
  const databases = systemDatabases();
  const memories = (request: ReturnType<typeof databases.connect>["request"]) =>
    createMemoryModule(request, {
      ...knobs,
      embeddingDimensions: EMBEDDING_SPACE.dimensions,
      embeddingProvider: provider,
    });

  return {
    id: "memory-search",
    corpusEntries: [THIS_FILE],
    runEntries: [THIS_FILE],
    ingestIdentity: () => ({
      system: "memory-search",
      ingestRevision: 2,
      records:
        "one Alice-private Memory per record, with its occurredAt; metadata evalUnit, evalKey, evalAnchorKey",
      tripwires: "one Bob-private Memory each, never embedded",
      chunking: MEMORY_CHUNKING_REVISION,
      embedding: EMBEDDING_SPACE,
    }),
    retrievalIdentity: () => ({ limit, knobs, embedding: EMBEDDING_SPACE }),

    async ingest(context: SystemContext, units: EvalUnit[]): Promise<IngestOutcome> {
      const connected = databases.connect(context.databaseUrl);
      const alice = memories(connected.request);
      // Tripwires are written without a provider, so no embedding job exists that Alice cannot see.
      const bob = createMemoryModule(connected.request, {
        ...knobs,
        embeddingDimensions: EMBEDDING_SPACE.dimensions,
      });
      return seedUnits({
        context,
        units,
        databases: connected,
        provider,
        counters,
        coverage: (unit, workspaceId) => memoryCoverage(connected.admin, workspaceId, unit),
        async seedUnit(unit, workspaceId) {
          for (const record of unit.records) {
            await alice.remember(
              { workspaceId, userId: ALICE },
              {
                content: record.text,
                scope: "private",
                ...(record.occurredAt ? { occurredAt: record.occurredAt } : {}),
                metadata: {
                  evalUnit: unit.key,
                  evalKey: record.key,
                  ...(record.anchorKey ? { evalAnchorKey: record.anchorKey } : {}),
                },
              },
            );
          }
          for (const [index, tripwire] of unit.tripwires.entries()) {
            await bob.remember(
              { workspaceId, userId: BOB },
              {
                content: tripwire,
                scope: "private",
                metadata: { evalUnit: unit.key, evalTripwire: index },
              },
            );
          }
        },
      });
    },

    async retrieve(context: SystemContext, unit: EvalUnit, evalCase: EvalCase): Promise<Packet> {
      const { request } = databases.connect(context.databaseUrl);
      const failuresBefore = counters.failures;
      const startedAt = performance.now();
      const results = await memories(request).search(
        { workspaceId: context.workspaceIdFor(unit), userId: ALICE },
        { query: evalCase.searchQuery, limit, metadataFilter: { evalUnit: unit.key } },
      );
      const latencyMs = performance.now() - startedAt;
      // The engine quietly falls back to lexical search when the query embedding fails.
      if (counters.failures !== failuresBefore) {
        throw new Error(`${evalCase.id}: the query embedding failed`);
      }
      return {
        latencyMs,
        items: results.map((result) => {
          const metadata = result.memory.metadata as Record<string, unknown>;
          const key = String(metadata.evalAnchorKey ?? metadata.evalKey ?? "");
          return {
            id: metadata.evalTripwire === undefined ? `memory:${key}` : "tripwire",
            text: result.evidence,
            ...(result.memory.occurredAt ? { occurredAt: result.memory.occurredAt } : {}),
            sourceKeys: metadata.evalTripwire === undefined ? [key] : [],
          };
        }),
      };
    },

    usage: () => ({
      embeddingsFromStore: counters.cached,
      embeddingsNew: counters.embedded,
      embeddingRequests: counters.requests,
      embeddingFailures: counters.failures,
    }),

    close: () => databases.close(),
  };
}
