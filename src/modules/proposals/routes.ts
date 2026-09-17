import { Hono } from "hono";
import { memoryEtag, memoryScope, metadata, requiredMemoryContent } from "@/modules/memories/input";
import type { ApiEnv } from "@/server/api/dependencies";
import {
  BadRequestError,
  idempotencyRequest,
  jsonObject,
  positiveInteger,
  queryInteger,
  requireHumanActor,
  uuidArray,
  uuidString,
} from "@/server/api/input";
import { observeOperation } from "@/server/telemetry/telemetry";
import type { MemoryProposalStatus, ProposeMemoryCodeEvidence } from "./service";
import { createMemoryProposalsModule } from "./service";

function memoryProposalStatus(value: string | null): MemoryProposalStatus | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value === "pending" || value === "accepted" || value === "rejected") return value;
  throw new BadRequestError("status must be pending, accepted, or rejected");
}

function proposalCodeEvidence(value: unknown): ProposeMemoryCodeEvidence[] {
  if (!Array.isArray(value)) {
    throw new BadRequestError("codeEvidence must be an array");
  }
  if (value.length > 50) throw new BadRequestError("codeEvidence exceeds 50 items");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BadRequestError(`codeEvidence[${index}] must be an object`);
    }
    const evidence = item as Record<string, unknown>;
    const relationship = evidence.relationship;
    if (
      relationship !== "supports" &&
      relationship !== "contradicts" &&
      relationship !== "implements" &&
      relationship !== "rationale"
    ) {
      throw new BadRequestError(
        `codeEvidence[${index}].relationship must be supports, contradicts, implements, or rationale`,
      );
    }
    return {
      artifactId: uuidString(evidence.artifactId, `codeEvidence[${index}].artifactId`),
      relationship,
    };
  });
}

export const proposals = new Hono<ApiEnv>()
  .get("/", async (c) => {
    const proposals = createMemoryProposalsModule(await c.var.database());
    const request = c.req.raw;
    const actor = requireHumanActor(await c.var.resolveActor());
    const url = new URL(request.url);
    const proposalList = await observeOperation("memory-proposal.list", () =>
      proposals.listProposals(actor, {
        limit: queryInteger(url, "limit", 50, 1, 100),
        status: memoryProposalStatus(url.searchParams.get("status")),
      }),
    );
    return c.json(proposalList);
  })
  .post("/", async (c) => {
    const proposals = createMemoryProposalsModule(await c.var.database());
    const request = c.req.raw;
    const actor = await c.var.resolveActor();
    const body = await jsonObject(request);
    const evidenceMemoryIds =
      body.evidenceMemoryIds === undefined
        ? []
        : uuidArray(body.evidenceMemoryIds, "evidenceMemoryIds", true);
    const evidenceObservationIds =
      body.evidenceObservationIds === undefined
        ? []
        : uuidArray(body.evidenceObservationIds, "evidenceObservationIds", true);
    const codeEvidence =
      body.codeEvidence === undefined ? [] : proposalCodeEvidence(body.codeEvidence);
    if (evidenceMemoryIds.length + evidenceObservationIds.length + codeEvidence.length > 50) {
      throw new BadRequestError("Proposal evidence exceeds 50 items");
    }
    const input =
      body.kind === "create"
        ? {
            kind: "create" as const,
            content: requiredMemoryContent(body.content),
            scope: memoryScope(body.scope),
            metadata: metadata(body.metadata),
            evidenceMemoryIds,
            evidenceObservationIds,
            codeEvidence,
          }
        : body.kind === "update"
          ? {
              kind: "update" as const,
              targetMemoryId: uuidString(body.targetMemoryId, "targetMemoryId"),
              expectedVersion: positiveInteger(body.expectedVersion, "expectedVersion"),
              content: body.content === undefined ? undefined : requiredMemoryContent(body.content),
              scope: memoryScope(body.scope),
              metadata: metadata(body.metadata),
              evidenceMemoryIds,
              evidenceObservationIds,
              codeEvidence,
            }
          : null;
    if (!input) throw new BadRequestError("kind must be create or update");
    if (
      input.kind === "update" &&
      input.content === undefined &&
      input.scope === undefined &&
      input.metadata === undefined
    ) {
      throw new BadRequestError("An update proposal must change content, scope, or metadata");
    }
    const proposal = await observeOperation("memory-proposal.create", async () =>
      proposals.propose(actor, input, {
        idempotency: await idempotencyRequest(request, "memory-proposal.create", input),
      }),
    );
    return c.json(proposal, 201);
  })
  .post("/:id/review", async (c) => {
    const proposals = createMemoryProposalsModule(await c.var.database(), c.var.memoryOptions());
    const request = c.req.raw;
    const id = c.req.param("id");
    const proposalId = uuidString(id, "proposalId");
    const actor = requireHumanActor(await c.var.resolveActor());
    const body = await jsonObject(request);
    if (body.decision !== "accept" && body.decision !== "reject") {
      throw new BadRequestError("decision must be accept or reject");
    }
    const decision = body.decision;
    const reviewed = await observeOperation("memory-proposal.review", () =>
      proposals.reviewProposal(actor, proposalId, decision),
    );
    return reviewed
      ? c.json(reviewed, {
          headers: { ...(reviewed.memory ? { etag: memoryEtag(reviewed.memory.version) } : {}) },
        })
      : c.json({ code: "not_found", error: "Memory Proposal not found" }, 404);
  });
