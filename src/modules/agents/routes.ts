import { Hono } from "hono";
import type { ApiEnv } from "@/server/api/dependencies";
import {
  BadRequestError,
  jsonObject,
  requiredString,
  requireHumanActor,
  uuidString,
} from "@/server/api/input";
import type { AgentGrantPermission, AgentStatus } from "@/server/auth/access";
import { createAccessModule } from "@/server/auth/access";

function agentPermission(
  value: unknown,
  defaultPermission?: AgentGrantPermission,
): AgentGrantPermission {
  if (value === undefined && defaultPermission) return defaultPermission;
  if (value === "read" || value === "write") return value;
  throw new BadRequestError("permission must be read or write");
}

function agentStatus(value: unknown): AgentStatus {
  if (value === "active" || value === "disabled") return value;
  throw new BadRequestError("status must be active or disabled");
}

export const agents = new Hono<ApiEnv>()
  .get("/", async (c) => {
    const access = createAccessModule(await c.var.database());
    const actor = requireHumanActor(await c.var.resolveActor());
    return c.json(await access.listAgents(actor));
  })
  .post("/", async (c) => {
    const access = createAccessModule(await c.var.database());
    const request = c.req.raw;
    const actor = requireHumanActor(await c.var.resolveActor());
    const body = await jsonObject(request);
    const agent = await access.createAgentForWorkspace(actor, {
      name: requiredString(body.name, "name", 120),
      permission: agentPermission(body.permission, "read"),
    });
    return c.json(agent, 201);
  })
  .patch("/:id", async (c) => {
    const access = createAccessModule(await c.var.database());
    const request = c.req.raw;
    const agentId = c.req.param("id");
    const normalizedAgentId = uuidString(agentId, "agentId");
    const actor = requireHumanActor(await c.var.resolveActor());
    const body = await jsonObject(request);
    const unsupportedField = Object.keys(body).find(
      (field) => field !== "name" && field !== "status",
    );
    if (unsupportedField) {
      throw new BadRequestError(`${unsupportedField} is not a supported Agent field`);
    }
    if (body.name === undefined && body.status === undefined) {
      throw new BadRequestError("name or status is required");
    }
    const agent = await access.updateAgent(actor, normalizedAgentId, {
      name: body.name === undefined ? undefined : requiredString(body.name, "name", 120),
      status: body.status === undefined ? undefined : agentStatus(body.status),
    });
    return agent ? c.json(agent) : c.json({ code: "not_found", error: "Agent not found" }, 404);
  })
  .delete("/:id", async (c) => {
    const access = createAccessModule(await c.var.database());
    const agentId = c.req.param("id");
    const normalizedAgentId = uuidString(agentId, "agentId");
    const actor = requireHumanActor(await c.var.resolveActor());
    const result = await access.deleteAgent(actor, normalizedAgentId);
    if (result === "deleted") {
      return c.body(null, 204);
    }
    if (result === "must_disable") {
      return c.json({ code: "invalid_request", error: "Disable Agent before deleting it" }, 409);
    }
    return c.json({ code: "not_found", error: "Agent not found" }, 404);
  })
  .get("/:id/credentials", async (c) => {
    const access = createAccessModule(await c.var.database());
    const agentId = c.req.param("id");
    const normalizedAgentId = uuidString(agentId, "agentId");
    const actor = requireHumanActor(await c.var.resolveActor());
    return c.json(await access.listAgentCredentials(actor, normalizedAgentId));
  })
  .post("/:id/credentials", async (c) => {
    const access = createAccessModule(await c.var.database());
    const agentId = c.req.param("id");
    const normalizedAgentId = uuidString(agentId, "agentId");
    const actor = requireHumanActor(await c.var.resolveActor());
    return c.json(await access.issueAgentCredential(actor, normalizedAgentId), 201);
  })
  .put("/:id/grant", async (c) => {
    const access = createAccessModule(await c.var.database());
    const request = c.req.raw;
    const agentId = c.req.param("id");
    const normalizedAgentId = uuidString(agentId, "agentId");
    const actor = requireHumanActor(await c.var.resolveActor());
    const body = await jsonObject(request);
    return c.json(
      await access.grantAgent(actor, normalizedAgentId, {
        permission: agentPermission(body.permission),
      }),
    );
  })
  .delete("/:id/grant", async (c) => {
    const access = createAccessModule(await c.var.database());
    const agentId = c.req.param("id");
    const normalizedAgentId = uuidString(agentId, "agentId");
    const actor = requireHumanActor(await c.var.resolveActor());
    const revoked = await access.revokeAgentGrant(actor, normalizedAgentId);
    return revoked
      ? c.body(null, 204)
      : c.json({ code: "not_found", error: "Active Agent grant not found" }, 404);
  });

export const agentCredentials = new Hono<ApiEnv>().delete("/:id", async (c) => {
  const access = createAccessModule(await c.var.database());
  const credentialId = c.req.param("id");
  const normalizedCredentialId = uuidString(credentialId, "credentialId");
  const actor = requireHumanActor(await c.var.resolveActor());
  const revoked = await access.revokeAgentCredential(actor, normalizedCredentialId);
  return revoked
    ? c.body(null, 204)
    : c.json({ code: "not_found", error: "Agent credential not found" }, 404);
});
