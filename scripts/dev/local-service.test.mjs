import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMaintenanceEnvironment,
  buildRerankerArguments,
  buildRuntimeEnvironment,
  extendLocalEnvironment,
  localServiceConfiguration,
  renderLocalEnvironment,
  targetDatabaseUrl,
} from "./local-service.mjs";

const databaseEnvironment = {
  DATABASE_URL: "postgresql://lore_local_runtime:request@127.0.0.1:5432/lore",
  LORE_MAINTENANCE_DATABASE_URL:
    "postgresql://lore_local_maintenance_runtime:maintenance@127.0.0.1:5432/lore",
  LORE_MAINTENANCE_PASSWORD: "maintenance",
  LORE_RUNTIME_PASSWORD: "request",
};

test("local service defaults to local Postgres and hybrid retrieval", () => {
  const configuration = localServiceConfiguration(databaseEnvironment);
  assert.equal(configuration.database.adminUrl, "postgresql:///postgres");
  assert.equal(configuration.database.name, "lore");
  assert.equal(configuration.searchMode, "hybrid");
  assert.equal(configuration.reranker.model, "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF:Q8_0");
  assert.equal(configuration.reranker.parallel, 2);
  assert.equal(configuration.reranker.contextSize, 8192);
  assert.equal(configuration.reranker.physicalBatchSize, 2048);
  assert.deepEqual(buildRerankerArguments(configuration.reranker), [
    "--hf-repo",
    configuration.reranker.model,
    "--reranking",
    "--ctx-size",
    "8192",
    "--host",
    "127.0.0.1",
    "--port",
    "8080",
    "--no-webui",
    "--parallel",
    "2",
    "--ubatch-size",
    "2048",
    "--n-gpu-layers",
    "all",
  ]);
});

test("hybrid runtime disables reranking and keeps calibrated retrieval settings", () => {
  const configuration = localServiceConfiguration(databaseEnvironment);
  const environment = buildRuntimeEnvironment(databaseEnvironment, configuration);
  assert.equal(environment.DATABASE_URL, databaseEnvironment.DATABASE_URL);
  assert.equal(environment.LORE_MAINTENANCE_DATABASE_URL, undefined);
  assert.equal(environment.LORE_MAINTENANCE_PASSWORD, undefined);
  assert.equal(environment.LORE_RUNTIME_PASSWORD, undefined);
  assert.equal(environment.LORE_RERANK_BASE_URL, "http://127.0.0.1:8080");
  assert.equal(environment.LORE_RERANK_PROVIDER, "");
  assert.equal(environment.LORE_SEMANTIC_DISTANCE_THRESHOLD, "0.5");
  assert.equal(environment.LORE_RERANK_CANDIDATE_LIMIT, "20");
  assert.equal(environment.LORE_RERANK_WEIGHT, "0.75");
});

test("maintenance runtime receives only its database credential", () => {
  const configuration = localServiceConfiguration(databaseEnvironment);
  const environment = buildMaintenanceEnvironment(databaseEnvironment, configuration);
  assert.equal(environment.DATABASE_URL, undefined);
  assert.equal(
    environment.LORE_MAINTENANCE_DATABASE_URL,
    databaseEnvironment.LORE_MAINTENANCE_DATABASE_URL,
  );
  assert.equal(environment.LORE_MAINTENANCE_PASSWORD, undefined);
  assert.equal(environment.LORE_RUNTIME_PASSWORD, undefined);
});

test("reranking remains an explicit deployment-level mode", () => {
  const source = { ...databaseEnvironment, LORE_LOCAL_SEARCH_MODE: "rerank" };
  const configuration = localServiceConfiguration(source);
  const environment = buildRuntimeEnvironment(source, configuration);
  assert.equal(configuration.searchMode, "rerank");
  assert.equal(environment.LORE_RERANK_PROVIDER, "llamacpp");
});

test("explicit process settings override service defaults", () => {
  const configuration = localServiceConfiguration({
    ...databaseEnvironment,
    LORE_LOCAL_RERANK_CTX_SIZE: "16384",
    LORE_LOCAL_RERANK_PARALLEL: "4",
    LORE_LOCAL_RERANK_PORT: "8181",
    LORE_PORT: "3100",
  });
  assert.equal(configuration.appPort, 3100);
  assert.equal(configuration.reranker.parallel, 4);
  assert.equal(configuration.reranker.contextSize, 16384);
  assert.equal(configuration.reranker.port, 8181);
});

test("environment initialization creates distinct native runtime credentials", () => {
  const example = [
    "LORE_DB_ADMIN_PASSWORD=change-this-admin-password",
    "LORE_DB_RUNTIME_PASSWORD=change-this-runtime-password",
    "LORE_DB_MAINTENANCE_PASSWORD=change-this-maintenance-password",
    "LORE_SEMANTIC_DISTANCE_THRESHOLD=0.5",
  ].join("\n");
  let index = 0;
  const rendered = renderLocalEnvironment(example, () => `secret-${++index}`);
  assert.match(rendered, /LORE_DB_ADMIN_PASSWORD=secret-1/);
  assert.match(rendered, /LORE_RUNTIME_PASSWORD=secret-2/);
  assert.match(rendered, /LORE_MAINTENANCE_PASSWORD=secret-3/);
  assert.match(
    rendered,
    /DATABASE_URL=postgresql:\/\/lore_local_runtime:secret-2@127\.0\.0\.1:5432\/lore/,
  );
  assert.match(rendered, /LORE_SEMANTIC_DISTANCE_THRESHOLD=0\.5/);
  assert.match(rendered, /LORE_LOCAL_SEARCH_MODE=hybrid/);
});

test("existing Docker environment is extended idempotently for the native service", () => {
  const existing = [
    "LORE_DB_ADMIN_PASSWORD=change-this-admin-password",
    "LORE_DB_RUNTIME_PASSWORD=change-this-runtime-password",
    "LORE_DB_MAINTENANCE_PASSWORD=change-this-maintenance-password",
    "AUTH_MODE=none",
  ].join("\n");
  let index = 0;
  const extended = extendLocalEnvironment(existing, () => `secret-${++index}`);
  assert.match(extended, /LORE_DB_ADMIN_PASSWORD=secret-1/);
  assert.match(extended, /DATABASE_URL=postgresql:\/\/lore_local_runtime:secret-2@/);
  assert.match(extended, /LORE_MAINTENANCE_DATABASE_URL=.*secret-3@/);
  assert.equal(
    extendLocalEnvironment(extended, () => "unused"),
    extended,
  );
});

test("partial native environment reports every missing database setting", () => {
  assert.throws(
    () => extendLocalEnvironment("DATABASE_URL=postgresql://partial@127.0.0.1/lore\n"),
    /partial native service configuration.*LORE_LOCAL_POSTGRES_ADMIN_URL/,
  );
});

test("local search mode rejects unknown values", () => {
  assert.throws(
    () => localServiceConfiguration({ ...databaseEnvironment, LORE_LOCAL_SEARCH_MODE: "both" }),
    /must be hybrid or rerank/,
  );
});

test("native service rejects conflicting reranker configuration", () => {
  assert.throws(
    () =>
      localServiceConfiguration({
        ...databaseEnvironment,
        LORE_RERANK_PROVIDER: "vllm-score",
      }),
    /conflicts with LORE_LOCAL_SEARCH_MODE/,
  );
});

test("native service rejects database and role drift between settings and URLs", () => {
  assert.throws(
    () =>
      localServiceConfiguration({
        ...databaseEnvironment,
        LORE_LOCAL_POSTGRES_DATABASE: "lore_v2",
      }),
    /DATABASE_URL must connect to database lore_v2/,
  );
  assert.throws(
    () =>
      localServiceConfiguration({
        ...databaseEnvironment,
        LORE_RUNTIME_ROLE: "another_runtime",
      }),
    /DATABASE_URL must connect to database lore as role another_runtime/,
  );
  assert.throws(
    () =>
      localServiceConfiguration({
        ...databaseEnvironment,
        LORE_LOCAL_POSTGRES_DATABASE: "unsafe-name",
      }),
    /safe lowercase Postgres identifier/,
  );
});

test("target database URL preserves the local admin transport", () => {
  assert.equal(targetDatabaseUrl("postgresql:///postgres", "lore"), "postgresql:///lore");
  assert.throws(() => targetDatabaseUrl("postgresql:///postgres", "unsafe-name"));
});
