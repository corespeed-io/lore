import type { PostgresDatabase } from "@corespeed/lore-core";
import type {
  EpisodeKind,
  ObservationKind,
  RecordObservation,
} from "@corespeed/lore-core/episodes";
import {
  createObservationModule,
  MAX_EPISODE_CONTENT_CHARACTERS,
  MAX_EPISODE_METADATA_CHARACTERS,
  MAX_EPISODE_OBSERVATIONS,
  MAX_OBSERVATION_BATCH_READ,
  MAX_OBSERVATION_CONTENT_CHARACTERS,
} from "@corespeed/lore-core/episodes";
import { decodeCursor, encodeCursor } from "@/modules/memories/http";
import { memoryScope, metadata } from "@/modules/memories/input";
import { createRequestContextResolver } from "@/server/auth/request-context";
import { errorResponse } from "@/server/http/errors";
import {
  BadRequestError,
  idempotencyRequest,
  jsonObject,
  optionalTimestamp,
  queryInteger,
  requiredRawString,
  uuidString,
} from "@/server/http/input";
import { observeOperation } from "@/server/telemetry/telemetry";

function episodeKind(value: unknown, optional = false): EpisodeKind | undefined {
  if (optional && (value === undefined || value === null || value === "")) return undefined;
  if (
    value === "conversation" ||
    value === "workflow" ||
    value === "document" ||
    value === "event"
  ) {
    return value;
  }
  throw new BadRequestError("kind must be conversation, workflow, document, or event");
}

function observationKind(value: unknown, name: string): ObservationKind {
  if (
    value === "message" ||
    value === "tool_call" ||
    value === "tool_result" ||
    value === "document_fragment" ||
    value === "event"
  ) {
    return value;
  }
  throw new BadRequestError(
    `${name} must be message, tool_call, tool_result, document_fragment, or event`,
  );
}

function episodeObservations(value: unknown): RecordObservation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EPISODE_OBSERVATIONS) {
    throw new BadRequestError(`observations must contain 1 to ${MAX_EPISODE_OBSERVATIONS} items`);
  }
  const observations = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BadRequestError(`observations[${index}] must be an object`);
    }
    const observation = item as Record<string, unknown>;
    if (observation.observedAt !== undefined && typeof observation.observedAt !== "string") {
      throw new BadRequestError(`observations[${index}].observedAt must be an ISO 8601 timestamp`);
    }
    const observedAt = optionalTimestamp(
      observation.observedAt ?? null,
      `observations[${index}].observedAt`,
    );
    return {
      kind: observationKind(observation.kind, `observations[${index}].kind`),
      content: requiredRawString(
        observation.content,
        `observations[${index}].content`,
        MAX_OBSERVATION_CONTENT_CHARACTERS,
      ),
      metadata: metadata(observation.metadata),
      observedAt,
    };
  });
  const totalCharacters = observations.reduce(
    (total, observation) => total + observation.content.length,
    0,
  );
  if (totalCharacters > MAX_EPISODE_CONTENT_CHARACTERS) {
    throw new BadRequestError(
      `Episode content exceeds ${MAX_EPISODE_CONTENT_CHARACTERS} characters`,
    );
  }
  const totalMetadataCharacters = observations.reduce(
    (total, observation) => total + JSON.stringify(observation.metadata ?? {}).length,
    0,
  );
  if (totalMetadataCharacters > MAX_EPISODE_METADATA_CHARACTERS) {
    throw new BadRequestError(
      `Episode metadata exceeds ${MAX_EPISODE_METADATA_CHARACTERS} characters`,
    );
  }
  return observations;
}

export function createEpisodeHandlers(database: PostgresDatabase) {
  const observations = createObservationModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const url = new URL(request.url);
        const cursor = decodeCursor(url.searchParams.get("cursor"));
        const limit = queryInteger(url, "limit", 50, 1, 100);
        const episodes = await observeOperation("episode.list", () =>
          observations.list(actor, {
            cursor: cursor ? { id: cursor.id, createdAt: cursor.updatedAt } : undefined,
            kind: episodeKind(url.searchParams.get("kind"), true),
            limit,
            scope: memoryScope(url.searchParams.get("scope") ?? undefined),
          }),
        );
        const headers = new Headers({ "cache-control": "private, no-store" });
        const last = episodes.length === limit ? episodes.at(-1) : undefined;
        if (last) {
          headers.set(
            "x-lore-next-cursor",
            encodeCursor({ id: last.id, updatedAt: last.createdAt }),
          );
        }
        return Response.json(episodes, { headers });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async POST(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const body = await jsonObject(request);
        const input = {
          kind: episodeKind(body.kind) as EpisodeKind,
          scope: memoryScope(body.scope) ?? "private",
          observations: episodeObservations(body.observations),
        };
        const episode = await observeOperation("episode.record", async () =>
          observations.record(actor, input, {
            idempotency: await idempotencyRequest(request, "episode.record", input),
          }),
        );
        return Response.json(episode, {
          status: 201,
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createObservationHandlers(database: PostgresDatabase) {
  const observations = createObservationModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const requestedIds = new URL(request.url).searchParams.getAll("id");
        if (requestedIds.length < 1 || requestedIds.length > MAX_OBSERVATION_BATCH_READ) {
          throw new BadRequestError(`id must be repeated 1 to ${MAX_OBSERVATION_BATCH_READ} times`);
        }
        const ids = requestedIds.map((id, index) => uuidString(id, `id[${index}]`));
        const visible = await observeOperation("observation.retrieve-many", () =>
          observations.retrieveObservations(actor, ids),
        );
        return Response.json(visible, {
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createEpisodeByIdHandlers(database: PostgresDatabase) {
  const observations = createObservationModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request, id: string): Promise<Response> {
      try {
        const episodeId = uuidString(id, "episodeId");
        const actor = await resolver.resolveActor(request);
        const episode = await observeOperation("episode.retrieve", () =>
          observations.retrieve(actor, episodeId),
        );
        return episode
          ? Response.json(episode, { headers: { "cache-control": "private, no-store" } })
          : Response.json(
              { code: "not_found", error: "Episode not found" },
              { status: 404, headers: { "cache-control": "private, no-store" } },
            );
      } catch (error) {
        return errorResponse(error);
      }
    },

    async DELETE(request: Request, id: string): Promise<Response> {
      try {
        const episodeId = uuidString(id, "episodeId");
        const actor = await resolver.resolveActor(request);
        const deleted = await observeOperation("episode.forget", async () =>
          observations.forget(actor, episodeId, {
            idempotency: await idempotencyRequest(request, "episode.forget", { episodeId }),
          }),
        );
        return deleted
          ? new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } })
          : Response.json(
              { code: "not_found", error: "Episode not found" },
              { status: 404, headers: { "cache-control": "private, no-store" } },
            );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
