import { afterEach, mock, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endpointIsHealthy, readOllamaModels } from "./lib/health-check.ts";
import {
  buildMaintenanceEnvironment,
  buildRerankerArguments,
  buildRerankerEnvironment,
  buildRuntimeEnvironment,
  extendLocalEnvironment,
  isDatabaseCredentialSetting,
  localServiceConfiguration,
  nextDevelopmentEnvironmentNames,
  renderLocalEnvironment,
  targetDatabaseUrl,
} from "./local-service.ts";

const temporaryDirectories: string[] = [];
afterEach(() => {
  mock.restore();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const databaseEnvironment = {
  DATABASE_URL: "postgresql://lore_local_runtime:request@127.0.0.1:5432/lore",
  LORE_MAINTENANCE_DATABASE_URL:
    "postgresql://lore_local_maintenance_runtime:maintenance@127.0.0.1:5432/lore",
  LORE_MAINTENANCE_PASSWORD: "maintenance",
  LORE_RUNTIME_PASSWORD: "request",
};

function mockFetch(implementation: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, { preconnect: globalThis.fetch.preconnect }),
  );
}

test("local health probes discard response bodies and use a deadline", async () => {
  const response = new Response("healthy");
  const fetch = mockFetch(async (_url, options) => {
    assert.ok(options?.signal instanceof AbortSignal);
    return response;
  });
  assert.equal(await endpointIsHealthy("http://localhost/readyz"), true);
  assert.equal(response.bodyUsed, true);
  fetch.mockRestore();
});

test("Ollama SDK model probes preserve HTTP errors and release their body", async () => {
  const response = Response.json({ error: "private provider detail" }, { status: 503 });
  const fetch = mockFetch(async () => response);
  await assert.rejects(readOllamaModels("http://localhost:11434"), {
    message: "Ollama health check failed with HTTP 503",
  });
  assert.equal(fetch.mock.calls.length, 1);
  assert.equal(response.bodyUsed, true);
  fetch.mockRestore();
});

test("Ollama SDK lists models through its native endpoint", async () => {
  const models = { models: [{ name: "qwen3-embedding:0.6b" }] };
  const fetch = mockFetch(async (url) => {
    assert.equal(String(url), "http://localhost:11434/api/tags");
    return Response.json(models);
  });

  assert.deepEqual(await readOllamaModels("http://localhost:11434/"), models);
  fetch.mockRestore();
});

test("Ollama SDK network errors retain actionable service startup guidance", async () => {
  const fetch = mockFetch(async () => {
    throw new TypeError("connection refused");
  });

  await assert.rejects(readOllamaModels("http://localhost:11434"), {
    message: "Ollama is unavailable at http://localhost:11434. Start Ollama before Lore.",
  });
  assert.equal(fetch.mock.calls.length, 1);
  fetch.mockRestore();
});

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
  assert.equal(environment.LORE_MAINTENANCE_DATABASE_URL, "");
  assert.equal(environment.LORE_MAINTENANCE_PASSWORD, "");
  assert.equal(environment.LORE_RUNTIME_PASSWORD, "");
  assert.equal(environment.LORE_RERANK_BASE_URL, "http://127.0.0.1:8080");
  assert.equal(environment.LORE_RERANK_PROVIDER, "");
  assert.equal(environment.LORE_SEMANTIC_DISTANCE_THRESHOLD, "0.5");
  assert.equal(environment.LORE_RERANK_CANDIDATE_LIMIT, "20");
  assert.equal(environment.LORE_RERANK_WEIGHT, "0.75");
});

test("Next dotenv loading cannot restore privileged credentials to the app", () => {
  const directory = mkdtempSync(join(tmpdir(), "lore-app-environment-"));
  temporaryDirectories.push(directory);
  const blockedNames = [
    "LORE_DB_ADMIN_PASSWORD",
    "LORE_DB_MAINTENANCE_PASSWORD",
    "LORE_DB_RUNTIME_PASSWORD",
    "LORE_LOCAL_POSTGRES_ADMIN_URL",
    "LORE_MAINTENANCE_DATABASE_URL",
    "LORE_MAINTENANCE_PASSWORD",
    "LORE_RUNTIME_PASSWORD",
  ];
  writeFileSync(
    join(directory, ".env"),
    blockedNames.map((name) => `${name}=privileged`).join("\n"),
  );
  const require = createRequire(import.meta.url);
  const nextEnvironmentPath = require.resolve("@next/env", { paths: [require.resolve("next")] });
  const result = spawnSync(
    process.execPath,
    [
      "--no-env-file",
      "--eval",
      `
    require(${JSON.stringify(nextEnvironmentPath)}).loadEnvConfig(process.cwd());
    process.stdout.write(JSON.stringify({
      runtime: typeof Bun,
      requestDatabase: process.env.DATABASE_URL,
      blocked: ${JSON.stringify(blockedNames)}.map((name) => process.env[name]),
    }));
  `,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: buildRuntimeEnvironment(
        databaseEnvironment,
        localServiceConfiguration(databaseEnvironment),
      ),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    runtime: "object",
    requestDatabase: databaseEnvironment.DATABASE_URL,
    blocked: blockedNames.map(() => ""),
  });
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

test("Bun maintenance subprocesses do not reload credentials from dotenv files", () => {
  const directory = mkdtempSync(join(tmpdir(), "lore-maintenance-environment-"));
  temporaryDirectories.push(directory);
  const blockedNames = [
    "DATABASE_URL",
    "LORE_LOCAL_POSTGRES_ADMIN_URL",
    "LORE_DB_ADMIN_PASSWORD",
    "LORE_DB_RUNTIME_PASSWORD",
    "LORE_DB_MAINTENANCE_PASSWORD",
    "LORE_MAINTENANCE_PASSWORD",
    "LORE_RUNTIME_PASSWORD",
  ];
  for (const file of [".env", ".env.local"]) {
    writeFileSync(
      join(directory, file),
      blockedNames.map((name) => `${name}=privileged`).join("\n"),
    );
  }
  const result = spawnSync(
    process.execPath,
    ["--no-env-file", "--eval", "process.stdout.write(JSON.stringify(process.env))"],
    {
      cwd: directory,
      encoding: "utf8",
      env: buildMaintenanceEnvironment(
        databaseEnvironment,
        localServiceConfiguration(databaseEnvironment),
      ),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const environment: unknown = JSON.parse(result.stdout);
  assert.ok(typeof environment === "object" && environment !== null);
  for (const name of blockedNames) assert.equal(Object.hasOwn(environment, name), false, name);
  assert.deepEqual(environment, {
    LORE_MAINTENANCE_DATABASE_URL: databaseEnvironment.LORE_MAINTENANCE_DATABASE_URL,
  });
});

// Credentials other tools read from the same .env or shell; none belongs to a child.
const foreignCredentials = {
  BENCHMARK_DATABASE_URL: "postgresql://owner:benchmark@127.0.0.1:5432/lore_benchmark",
  CODE_SEARCH_BENCHMARK_DATABASE_URL: "postgresql://owner:code@127.0.0.1:5432/lore_bench",
  LORE_BASIC_PASSWORD: "operator",
  LORE_DBMATE_DATABASE_URL: "postgresql://owner:dbmate@127.0.0.1:5432/lore",
  LORE_RESTORE_DATABASE_URL: "postgresql://owner:restore@127.0.0.1:5432/lore_restore",
  LORE_SMOKE_DATABASE_URL: "postgresql://owner:smoke@127.0.0.1:5432/lore_smoke",
  PGHOST: "127.0.0.1",
  PGPASSWORD: "libpq-owner",
  PGUSER: "postgres",
};
const childSettings = {
  OPENAI_API_KEY: "provider-key",
  PATH: "/usr/bin",
  UI_PASSWORD: "ui-password",
};

test("credential classification covers tool URLs and libpq defaults but not app settings", () => {
  for (const name of Object.keys(foreignCredentials)) {
    assert.equal(isDatabaseCredentialSetting(name), true, name);
  }
  for (const name of [...Object.keys(childSettings), "LORE_EMBEDDING_PROVIDER", "PORT"]) {
    assert.equal(isDatabaseCredentialSetting(name), false, name);
  }
});

test("every managed child receives only its own database credential", () => {
  const source = { ...databaseEnvironment, ...foreignCredentials, ...childSettings };
  const configuration = localServiceConfiguration(source);

  const app = buildRuntimeEnvironment(source, configuration);
  assert.equal(app.DATABASE_URL, configuration.database.requestUrl);
  for (const name of [...Object.keys(foreignCredentials), "LORE_MAINTENANCE_DATABASE_URL"]) {
    assert.equal(app[name], "", name);
  }

  const maintenance = buildMaintenanceEnvironment(source, configuration);
  assert.equal(maintenance.LORE_MAINTENANCE_DATABASE_URL, configuration.database.maintenanceUrl);
  for (const name of [...Object.keys(foreignCredentials), "DATABASE_URL"]) {
    assert.equal(Object.hasOwn(maintenance, name), false, name);
  }

  const reranker = buildRerankerEnvironment(source);
  for (const name of [...Object.keys(foreignCredentials), ...Object.keys(databaseEnvironment)]) {
    assert.equal(Object.hasOwn(reranker, name), false, name);
  }

  for (const child of [app, maintenance, reranker]) {
    for (const [name, value] of Object.entries(childSettings)) assert.equal(child[name], value);
  }
});

test("Next dev dotenv files cannot restore credentials absent from the service environment", () => {
  const directory = mkdtempSync(join(tmpdir(), "lore-app-dotenv-"));
  temporaryDirectories.push(directory);
  // Present only in files Next reloads for `next dev`, never in the manager's .env.
  writeFileSync(join(directory, ".env.local"), "LORE_SMOKE_DATABASE_URL=privileged\n");
  writeFileSync(join(directory, ".env.development"), "PGPASSWORD=privileged\nAPP_TITLE=Lore\n");
  const reloadableNames = nextDevelopmentEnvironmentNames(directory);
  assert.deepEqual(reloadableNames.sort(), ["APP_TITLE", "LORE_SMOKE_DATABASE_URL", "PGPASSWORD"]);

  const require = createRequire(import.meta.url);
  const nextEnvironmentPath = require.resolve("@next/env", { paths: [require.resolve("next")] });
  const configuration = localServiceConfiguration(databaseEnvironment);
  const loadInNextDev = (names: string[]) => {
    const result = spawnSync(
      process.execPath,
      [
        "--no-env-file",
        "--eval",
        `
      require(${JSON.stringify(nextEnvironmentPath)}).loadEnvConfig(process.cwd(), true);
      process.stdout.write(JSON.stringify([
        process.env.LORE_SMOKE_DATABASE_URL,
        process.env.PGPASSWORD,
        process.env.APP_TITLE,
      ]));
    `,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: buildRuntimeEnvironment(databaseEnvironment, configuration, names),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  // Control: without the reloadable names, Next restores both credentials.
  assert.deepEqual(loadInNextDev([]), ["privileged", "privileged", "Lore"]);
  assert.deepEqual(loadInNextDev(reloadableNames), ["", "", "Lore"]);
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
