import { Hono } from "hono";
import {
  CODE_EVIDENCE_RELATIONSHIP_MESSAGE,
  isCodeEvidenceRelationship,
} from "@/modules/code/evidence-contract";
import { memoryEtag, requiredMemoryContent } from "@/modules/memories/input";
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
import { memoryScope, metadata } from "@/server/api/shared-schemas";
import { observeOperation } from "@/server/telemetry/telemetry";
import { MAXIMUM_MEMORY_PROPOSAL_LIST } from "./limits";
import type { MemoryProposalStatus, ProposeMemoryCodeEvidence } from "./service";
import {
  createMemoryProposalsModule,
  MEMORY_PROPOSAL_KINDS,
  MEMORY_PROPOSAL_STATUSES,
} from "./service";

function memoryProposalStatus(value: string | null): MemoryProposalStatus | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (MEMORY_PROPOSAL_STATUSES.includes(value as MemoryProposalStatus)) {
    return value as MemoryProposalStatus;
  }
  throw new BadRequestError(`status must be ${MEMORY_PROPOSAL_STATUSES.join(", ")}`);
}

function proposalCodeEvidence(value: unknown): ProposeMemoryCodeEvidence[] {
  if (!Array.isArray(value)) {
    throw new BadRequestError("codeEvidence must be an array");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BadRequestError(`codeEvidence[${index}] must be an object`);
    }
    const evidence = item as Record<string, unknown>;
    const relationship = evidence.relationship;
    if (!isCodeEvidenceRelationship(relationship)) {
      throw new BadRequestError(`codeEvidence[${index}].${CODE_EVIDENCE_RELATIONSHIP_MESSAGE}`);
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
        limit: queryInteger(url, "limit", 50, 1, MAXIMUM_MEMORY_PROPOSAL_LIST),
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
    if (!input) throw new BadRequestError(`kind must be ${MEMORY_PROPOSAL_KINDS.join(" or ")}`);
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
