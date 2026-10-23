import { fileURLToPath } from "node:url";
import { MEMORY_CHUNKING_REVISION } from "@corespeed/lore-core";
import { MAX_EPISODE_OBSERVATIONS } from "@corespeed/lore-core/episodes";
import type pg from "pg";
import {
  createMemoryObservationEvidenceModule,
  MEMORY_OBSERVATION_EVIDENCE_LIMITS,
} from "../../../src/modules/episodes/observation-evidence";
import { createObservationModule } from "../../../src/modules/episodes/service";
import { createMemoryModule } from "../../../src/modules/memories/service";
import { createGoogleEmbeddingProvider } from "../../../src/server/providers/embedding/google";
import { strictRetrievalKnobsFromEnvironment } from "../../../src/server/providers/retrieval-knobs";
import { cachedEmbeddingProvider } from "./embedding-cache";
import type { SourceLayout } from "./source-layout";
import type { EvalStore } from "./store";
import {
  ALICE,
  BOB,
  EMBEDDING_SPACE,
  memoryCoverage,
  seedUnits,
  systemDatabases,
} from "./system-common";
import type {
  EvalCase,
  EvalSystem,
  EvalUnit,
  IngestOutcome,
  Packet,
  PacketItem,
  SystemContext,
} from "./types";

const THIS_FILE = fileURLToPath(import.meta.url);

/** Alice's and Bob's Observations and citations in a Unit's Workspace. */
async function sourceCoverage(
  admin: pg.Pool,
  workspaceId: string,
  unit: EvalUnit,
): Promise<string | undefined> {
  const { rows } = await admin.query<{ owner: string; observations: string; citations: string }>(
    `SELECT u.owner::text AS owner,
       (SELECT count(*) FROM observations o JOIN episodes e
          ON e.workspace_id = o.workspace_id AND e.id = o.episode_id
        WHERE o.workspace_id = $1 AND e.owner_user_id = u.owner)::text AS observations,
       (SELECT count(*) FROM memory_observation_evidence x JOIN memories m ON m.id = x.memory_id
        WHERE x.workspace_id = $1 AND m.owner_user_id = u.owner)::text AS citations
     FROM unnest(ARRAY[$2::uuid, $3::uuid]) AS u(owner)`,
    [workspaceId, ALICE, BOB],
  );
  const counts = new Map(rows.map((row) => [row.owner, row]));
  const alice = counts.get(ALICE);
  const bob = counts.get(BOB);
  const sources = unit.sources?.length ?? 0;
  const cites = unit.records.reduce((total, record) => total + (record.cites?.length ?? 0), 0);
  if (Number(alice?.observations) !== sources)
    return `${alice?.observations} of ${sources} sources`;
  if (Number(alice?.citations) !== cites) return `${alice?.citations} of ${cites} citations`;
  if (Number(bob?.observations) !== unit.tripwires.length)
    return `${bob?.observations} of ${unit.tripwires.length} tripwire sources`;
  if (Number(bob?.citations) !== unit.tripwires.length)
    return `${bob?.citations} of ${unit.tripwires.length} tripwire citations`;
  return undefined;
}

/**
 * Memory search plus the sources its hits cite, read through the shipped
 * Episode and Memory Observation Evidence modules. Each source becomes one
 * Alice-private Observation, and each record an Alice-private Memory that cites
 * the sources it was made from. A question is one Memory search and one read of
 * the cited sources at the product's default budget, laid out as the checked-out
 * code's `layout` says. Bob's tripwires are a private Memory citing a private
 * Observation of the same text, so a leak through either path fails the run.
 */
export function memorySourcesSystem(options: {
  store: EvalStore;
  geminiApiKey: string;
  layout: SourceLayout;
  limit?: number;
}): EvalSystem {
  const limit = options.limit ?? 10;
  const readCharacters = MEMORY_OBSERVATION_EVIDENCE_LIMITS.defaultReadCharacters;
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
  // Each Workspace's Observation ids, by the source key they were recorded under.
  const sourceKeys = new Map<string, Promise<Map<string, string | null>>>();

  return {
    id: "memory-sources",
    corpusEntries: [THIS_FILE],
    runEntries: [THIS_FILE, options.layout.entry],
    ingestIdentity: () => ({
      system: "memory-sources",
      ingestRevision: 2,
      sources: "one Alice-private conversation Episode per 100 sources; one document_fragment each",
      records:
        "one Alice-private Memory per record, with its occurredAt, citing its sources; metadata evalUnit, evalKey, evalAnchorKey",
      tripwires: "one Bob-private Memory each, never embedded, citing a Bob-private Observation",
      chunking: MEMORY_CHUNKING_REVISION,
      embedding: EMBEDDING_SPACE,
    }),
    retrievalIdentity: () => ({
      limit,
      knobs,
      embedding: EMBEDDING_SPACE,
      readCharacters,
      layout: options.layout.name,
    }),

    async ingest(context: SystemContext, units: EvalUnit[]): Promise<IngestOutcome> {
      const connected = databases.connect(context.databaseUrl);
      const alice = memories(connected.request);
      // Tripwires are written without a provider, so no embedding job exists that Alice cannot see.
      const bob = createMemoryModule(connected.request, {
        ...knobs,
        embeddingDimensions: EMBEDDING_SPACE.dimensions,
      });
      const episodes = createObservationModule(connected.request);
      const evidence = createMemoryObservationEvidenceModule(connected.request);
      return seedUnits({
        context,
        units,
        databases: connected,
        provider,
        counters,
        async coverage(unit, workspaceId) {
          const checked = await memoryCoverage(connected.admin, workspaceId, unit);
          if ("problem" in checked) return checked;
          const problem = await sourceCoverage(connected.admin, workspaceId, unit);
          return problem ? { problem } : checked;
        },
        async seedUnit(unit, workspaceId) {
          const actor = { workspaceId, userId: ALICE };
          const observationIds = new Map<string, string>();
          const sources = unit.sources ?? [];
          for (let start = 0; start < sources.length; start += MAX_EPISODE_OBSERVATIONS) {
            const batch = sources.slice(start, start + MAX_EPISODE_OBSERVATIONS);
            const episode = await episodes.record(actor, {
              kind: "conversation",
              scope: "private",
              observations: batch.map((source) => ({
                kind: "document_fragment",
                content: source.text,
                observedAt: source.observedAt,
                metadata: { evalUnit: unit.key, evalKey: source.key },
              })),
            });
            for (const observation of episode.observations) {
              observationIds.set(String(observation.metadata.evalKey), observation.id);
            }
            if (batch.some((source) => !observationIds.has(source.key))) {
              throw new Error(`${unit.key}: an Episode lost one of its sources`);
            }
          }
          for (const record of unit.records) {
            const memory = await alice.remember(actor, {
              content: record.text,
              scope: "private",
              ...(record.occurredAt ? { occurredAt: record.occurredAt } : {}),
              metadata: {
                evalUnit: unit.key,
                evalKey: record.key,
                ...(record.anchorKey ? { evalAnchorKey: record.anchorKey } : {}),
              },
            });
            for (const key of record.cites ?? []) {
              const observationId = observationIds.get(key);
              if (!observationId)
                throw new Error(`${unit.key}: ${record.key} cites unknown ${key}`);
              if (!(await evidence.cite(actor, { memoryId: memory.id, observationId }))) {
                throw new Error(`${unit.key}: the citation of ${key} was refused`);
              }
            }
          }
          if (unit.tripwires.length) {
            const bobActor = { workspaceId, userId: BOB };
            const episode = await episodes.record(bobActor, {
              kind: "conversation",
              scope: "private",
              observations: unit.tripwires.map((tripwire, index) => ({
                kind: "document_fragment",
                content: tripwire,
                metadata: { evalUnit: unit.key, evalTripwire: index },
              })),
            });
            for (const [index, tripwire] of unit.tripwires.entries()) {
              const memory = await bob.remember(bobActor, {
                content: tripwire,
                scope: "private",
                metadata: { evalUnit: unit.key, evalTripwire: index },
              });
              const observation = episode.observations[index];
              if (!observation) throw new Error(`${unit.key}: a tripwire Observation is missing`);
              if (
                !(await evidence.cite(bobActor, {
                  memoryId: memory.id,
                  observationId: observation.id,
                }))
              ) {
                throw new Error(`${unit.key}: Bob's tripwire citation was refused`);
              }
            }
          }
        },
      });
    },

    async retrieve(context: SystemContext, unit: EvalUnit, evalCase: EvalCase): Promise<Packet> {
      const { request, admin } = databases.connect(context.databaseUrl);
      const workspaceId = context.workspaceIdFor(unit);
      const actor = { workspaceId, userId: ALICE };
      let keys = sourceKeys.get(workspaceId);
      if (!keys) {
        keys = admin
          .query<{ id: string; key: string | null }>(
            "SELECT id, metadata->>'evalKey' AS key FROM observations WHERE workspace_id = $1",
            [workspaceId],
          )
          .then(({ rows }) => new Map(rows.map((row) => [row.id, row.key])));
        sourceKeys.set(workspaceId, keys);
      }
      const failuresBefore = counters.failures;
      const startedAt = performance.now();
      const results = await memories(request).search(actor, {
        query: evalCase.searchQuery,
        limit,
        metadataFilter: { evalUnit: unit.key },
      });
      const read = results.length
        ? await createMemoryObservationEvidenceModule(request).read(actor, {
            memoryIds: results.map((result) => result.memory.id),
            maximumCharacters: readCharacters,
          })
        : { sources: [], omittedObservationIds: [] };
      const latencyMs = performance.now() - startedAt;
      // The engine quietly falls back to lexical search when the query embedding fails.
      if (counters.failures !== failuresBefore) {
        throw new Error(`${evalCase.id}: the query embedding failed`);
      }
      const tripwires = new Set(unit.tripwires);
      const memoryItems: PacketItem[] = results.map((result) => {
        const metadata = result.memory.metadata as Record<string, unknown>;
        const key = String(metadata.evalAnchorKey ?? metadata.evalKey ?? "");
        return metadata.evalTripwire === undefined
          ? {
              id: `memory:${key}`,
              text: result.evidence,
              ...(result.memory.occurredAt ? { occurredAt: result.memory.occurredAt } : {}),
              sourceKeys: [key],
            }
          : { id: "tripwire", text: result.evidence, sourceKeys: [] };
      });
      const byObservation = await keys;
      const sourceItems: PacketItem[] = read.sources.map((source) => {
        // Bob's Observations carry no evalKey: reading one is an isolation failure.
        const key = byObservation.get(source.observationId);
        return !key || tripwires.has(source.content)
          ? { id: "tripwire", text: source.content, sourceKeys: [] }
          : { id: `source:${key}`, text: source.content, sourceKeys: [key] };
      });
      const items = options.layout
        .arrange(
          results.map((result) => result.memory.id),
          read.sources,
        )
        .map((slot) => {
          const item = slot.kind === "memory" ? memoryItems[slot.index] : sourceItems[slot.index];
          if (!item) throw new Error(`${evalCase.id}: the layout named a missing ${slot.kind}`);
          return item;
        });
      return { latencyMs, items };
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
