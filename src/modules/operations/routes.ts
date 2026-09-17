import { Hono } from "hono";
import type { ApiEnv } from "@/server/api/dependencies";
import { loreOpenApiDocument } from "@/server/openapi/document";
import { createOperationsModule, livenessReport } from "./service";

export const capabilities = new Hono<ApiEnv>().get("/", async (c) => {
  const database = await c.var.database();
  await c.var.resolveActor();
  const operations = createOperationsModule(database, {
    embeddingConfigured: Boolean(c.var.memoryOptions().embeddingProvider),
  });
  return c.json(await operations.capabilities());
});

export const operations = new Hono<ApiEnv>()
  .get("/livez", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(livenessReport());
  })
  .get("/api/health", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ...livenessReport(), deprecated: "Use /livez and /readyz" });
  })
  .get("/readyz", async (c) => {
    const operations = createOperationsModule(await c.var.database(), {
      embeddingConfigured: true,
      embeddingIdentity: c.var.memoryOptions().embeddingProvider,
    });
    const report = await operations.readiness();
    c.header("Cache-Control", "no-store");
    return c.json(report, report.status === "unready" ? 503 : 200);
  })
  .get("/openapi.json", (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    return c.json(loreOpenApiDocument());
  });
