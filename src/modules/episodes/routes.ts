import { MEMORY_LIST_LIMITS } from "@corespeed/lore-core";
import type { RecordObservation } from "@corespeed/lore-core/episodes";
import {
  MAX_EPISODE_CONTENT_CHARACTERS,
  MAX_EPISODE_METADATA_CHARACTERS,
  MAX_OBSERVATION_BATCH_READ,
  validateEpisodeKind,
  validateObservationKind,
} from "@corespeed/lore-core/episodes";
import { Hono } from "hono";
import { createObservationModule } from "@/modules/episodes/service";
import type { ApiEnv } from "@/server/api/dependencies";
import {
  BadRequestError,
  decodeCursor,
  encodeCursor,
  idempotencyRequest,
  jsonObject,
  optionalTimestamp,
  queryInteger,
  uuidString,
} from "@/server/api/input";
import { memoryScope, metadata } from "@/server/api/shared-schemas";
import { observeOperation } from "@/server/telemetry/telemetry";

/**
 * An Episode may reach its content and metadata limits with every UTF-16 unit sent
 * as a six-byte `\uXXXX` escape (the default of Python's json.dumps), so its body
 * bound allows that plus 1 MiB of envelope, above the default JSON body bound.
 */
const MAX_EPISODE_BODY_BYTES =
  6 * (MAX_EPISODE_CONTENT_CHARACTERS + MAX_EPISODE_METADATA_CHARACTERS) + 1024 * 1024;

function optionalEpisodeKind(value: string | null) {
  return value === null || value === "" ? undefined : validateEpisodeKind(value);
}

// Wire shapes only: the engine's normalizedEpisode owns kinds, counts, and bounds.
function episodeObservations(value: unknown): RecordObservation[] {
  if (!Array.isArray(value)) throw new BadRequestError("observations must be an array");
  return value.map((item, index) => {
    const name = `observations[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BadRequestError(`${name} must be an object`);
    }
    const observation = item as Record<string, unknown>;
    if (observation.observedAt !== undefined && typeof observation.observedAt !== "string") {
      throw new BadRequestError(`${name}.observedAt must be an ISO 8601 timestamp`);
    }
    if (typeof observation.content !== "string") {
      throw new BadRequestError(`${name}.content must be a string`);
    }
    return {
      kind: validateObservationKind(observation.kind, `${name}.kind`),
      content: observation.content,
      metadata: metadata(observation.metadata),
      observedAt: optionalTimestamp(observation.observedAt ?? null, `${name}.observedAt`),
    };
  });
}

export const episodes = new Hono<ApiEnv>()
  .get("/", async (c) => {
    const observations = createObservationModule(await c.var.database());
    const request = c.req.raw;
    const actor = await c.var.resolveActor();
    const url = new URL(request.url);
    const cursor = decodeCursor(url.searchParams.get("cursor"));
    const limit = queryInteger(
      url,
      "limit",
      MEMORY_LIST_LIMITS.defaultLimit,
      1,
      MEMORY_LIST_LIMITS.maximumLimit,
    );
    const episodes = await observeOperation("episode.list", () =>
      observations.list(actor, {
        cursor: cursor ? { id: cursor.id, createdAt: cursor.updatedAt } : undefined,
        kind: optionalEpisodeKind(url.searchParams.get("kind")),
        limit,
        scope: memoryScope(url.searchParams.get("scope") ?? undefined),
      }),
    );
    const headers = new Headers({ "cache-control": "private, no-store" });
    const last = episodes.length === limit ? episodes.at(-1) : undefined;
    if (last) {
      headers.set("x-lore-next-cursor", encodeCursor({ id: last.id, updatedAt: last.createdAt }));
    }
    return c.json(episodes, { headers });
  })
  .post("/", async (c) => {
    const observations = createObservationModule(await c.var.database());
    const request = c.req.raw;
    const actor = await c.var.resolveActor();
    const body = await jsonObject(request, MAX_EPISODE_BODY_BYTES);
    const input = {
      kind: validateEpisodeKind(body.kind),
      scope: memoryScope(body.scope) ?? "private",
      observations: episodeObservations(body.observations),
    };
    const episode = await observeOperation("episode.record", async () =>
      observations.record(actor, input, {
        idempotency: await idempotencyRequest(request, "episode.record", input),
      }),
    );
    return c.json(episode, 201);
  })
  .get("/:id", async (c) => {
    const observations = createObservationModule(await c.var.database());
    const id = c.req.param("id");
    const episodeId = uuidString(id, "episodeId");
    const actor = await c.var.resolveActor();
    const episode = await observeOperation("episode.retrieve", () =>
      observations.retrieve(actor, episodeId),
    );
    return episode
      ? c.json(episode)
      : c.json({ code: "not_found", error: "Episode not found" }, 404);
  })
  .delete("/:id", async (c) => {
    const observations = createObservationModule(await c.var.database());
    const request = c.req.raw;
    const id = c.req.param("id");
    const episodeId = uuidString(id, "episodeId");
    const actor = await c.var.resolveActor();
    const deleted = await observeOperation("episode.forget", async () =>
      observations.forget(actor, episodeId, {
        idempotency: await idempotencyRequest(request, "episode.forget", { episodeId }),
      }),
    );
    return deleted
      ? c.body(null, 204)
      : c.json({ code: "not_found", error: "Episode not found" }, 404);
  });

export const observations = new Hono<ApiEnv>().get("/", async (c) => {
  const observations = createObservationModule(await c.var.database());
  const request = c.req.raw;
  const actor = await c.var.resolveActor();
  const requestedIds = new URL(request.url).searchParams.getAll("id");
  if (requestedIds.length < 1 || requestedIds.length > MAX_OBSERVATION_BATCH_READ) {
    throw new BadRequestError(`id must be repeated 1 to ${MAX_OBSERVATION_BATCH_READ} times`);
  }
  const ids = requestedIds.map((id, index) => uuidString(id, `id[${index}]`));
  const visible = await observeOperation("observation.retrieve-many", () =>
    observations.retrieveObservations(actor, ids),
  );
  return c.json(visible);
});
