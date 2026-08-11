import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import pg from "pg";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const stateDirectory = join(repositoryRoot, "tmp", "local-service");
const environmentPath = join(repositoryRoot, ".env");
const environmentExamplePath = join(repositoryRoot, ".env.example");
const nextBinPath = join(repositoryRoot, "node_modules", "next", "dist", "bin", "next");
const maintenanceWorkerPath = join(repositoryRoot, ".worker", "maintenance-worker.js");

const defaultRerankerModel = "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF:Q8_0";
const managedProcessNames = ["app", "maintenance", "reranker"];
const nativeDatabaseSettings = [
  "DATABASE_URL",
  "LORE_LOCAL_POSTGRES_ADMIN_URL",
  "LORE_LOCAL_POSTGRES_DATABASE",
  "LORE_MAINTENANCE_DATABASE_URL",
  "LORE_MAINTENANCE_PASSWORD",
  "LORE_MAINTENANCE_ROLE",
  "LORE_RUNTIME_PASSWORD",
  "LORE_RUNTIME_ROLE",
];
const bootstrapSecretSettings = [
  "LORE_DB_ADMIN_PASSWORD",
  "LORE_DB_MAINTENANCE_PASSWORD",
  "LORE_DB_RUNTIME_PASSWORD",
];

function configuredValue(environment, name, fallback) {
  const value = environment[name]?.trim();
  return value ? value : fallback;
}

function requiredValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required in .env`);
  return value;
}

function integerSetting(environment, name, fallback, minimum, maximum) {
  const raw = configuredValue(environment, name, String(fallback));
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function searchMode(environment) {
  const mode = configuredValue(environment, "LORE_LOCAL_SEARCH_MODE", "hybrid").toLowerCase();
  if (mode !== "hybrid" && mode !== "rerank") {
    throw new Error("LORE_LOCAL_SEARCH_MODE must be hybrid or rerank");
  }
  return mode;
}

function safePostgresIdentifier(value, name) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`${name} must be a safe lowercase Postgres identifier`);
  }
  return value;
}

function assertDatabaseUrlMatches(urlString, name, databaseName, role) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${name} must use postgres:// or postgresql://`);
  }
  const configuredDatabase = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const configuredRole = decodeURIComponent(url.username);
  if (configuredDatabase !== databaseName || configuredRole !== role) {
    throw new Error(`${name} must connect to database ${databaseName} as role ${role}`);
  }
}

function assertRerankerConfiguration(environment, configuration) {
  const provider = environment.LORE_RERANK_PROVIDER?.trim().toLowerCase();
  const baseUrl = environment.LORE_RERANK_BASE_URL?.trim();
  if (provider && (configuration.searchMode !== "rerank" || provider !== "llamacpp")) {
    throw new Error(
      "LORE_RERANK_PROVIDER conflicts with LORE_LOCAL_SEARCH_MODE; unset it for hybrid or use llamacpp with rerank",
    );
  }
  if (baseUrl) {
    const expected = `http://127.0.0.1:${configuration.reranker.port}/`;
    let normalized;
    try {
      normalized = new URL(baseUrl).toString();
    } catch {
      throw new Error("LORE_RERANK_BASE_URL must be a valid URL");
    }
    if (configuration.searchMode !== "rerank" || normalized !== expected) {
      throw new Error(
        `LORE_RERANK_BASE_URL conflicts with the local service; unset it or use ${expected}`,
      );
    }
  }
}

export function targetDatabaseUrl(adminUrl, databaseName) {
  safePostgresIdentifier(databaseName, "LORE_LOCAL_POSTGRES_DATABASE");
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function localServiceConfiguration(environment = process.env) {
  const configuration = {
    appPort: integerSetting(environment, "LORE_PORT", 3000, 1, 65535),
    searchMode: searchMode(environment),
    database: {
      adminUrl: configuredValue(
        environment,
        "LORE_LOCAL_POSTGRES_ADMIN_URL",
        "postgresql:///postgres",
      ),
      maintenanceRole: safePostgresIdentifier(
        configuredValue(environment, "LORE_MAINTENANCE_ROLE", "lore_local_maintenance_runtime"),
        "LORE_MAINTENANCE_ROLE",
      ),
      maintenanceUrl: requiredValue(environment, "LORE_MAINTENANCE_DATABASE_URL"),
      maintenancePassword: requiredValue(environment, "LORE_MAINTENANCE_PASSWORD"),
      name: safePostgresIdentifier(
        configuredValue(environment, "LORE_LOCAL_POSTGRES_DATABASE", "lore"),
        "LORE_LOCAL_POSTGRES_DATABASE",
      ),
      requestRole: safePostgresIdentifier(
        configuredValue(environment, "LORE_RUNTIME_ROLE", "lore_local_runtime"),
        "LORE_RUNTIME_ROLE",
      ),
      requestUrl: requiredValue(environment, "DATABASE_URL"),
      requestPassword: requiredValue(environment, "LORE_RUNTIME_PASSWORD"),
    },
    reranker: {
      command: configuredValue(environment, "LORE_LOCAL_RERANK_COMMAND", "llama-server"),
      contextSize: integerSetting(environment, "LORE_LOCAL_RERANK_CTX_SIZE", 8192, 512, 131072),
      model: configuredValue(environment, "LORE_RERANK_MODEL", defaultRerankerModel),
      parallel: integerSetting(environment, "LORE_LOCAL_RERANK_PARALLEL", 2, 1, 16),
      physicalBatchSize: integerSetting(
        environment,
        "LORE_LOCAL_RERANK_UBATCH_SIZE",
        2048,
        512,
        8192,
      ),
      port: integerSetting(environment, "LORE_LOCAL_RERANK_PORT", 8080, 1, 65535),
      startTimeoutMs: integerSetting(
        environment,
        "LORE_LOCAL_RERANK_START_TIMEOUT_MS",
        600_000,
        10_000,
        3_600_000,
      ),
    },
  };
  assertDatabaseUrlMatches(
    configuration.database.requestUrl,
    "DATABASE_URL",
    configuration.database.name,
    configuration.database.requestRole,
  );
  assertDatabaseUrlMatches(
    configuration.database.maintenanceUrl,
    "LORE_MAINTENANCE_DATABASE_URL",
    configuration.database.name,
    configuration.database.maintenanceRole,
  );
  assertRerankerConfiguration(environment, configuration);
  return configuration;
}

export function buildRerankerArguments(configuration) {
  return [
    "--hf-repo",
    configuration.model,
    "--reranking",
    "--ctx-size",
    String(configuration.contextSize),
    "--host",
    "127.0.0.1",
    "--port",
    String(configuration.port),
    "--no-webui",
    "--parallel",
    String(configuration.parallel),
    "--ubatch-size",
    String(configuration.physicalBatchSize),
    "--n-gpu-layers",
    "all",
  ];
}

export function buildRuntimeEnvironment(environment, configuration) {
  const runtime = {
    ...environment,
    DATABASE_URL: configuration.database.requestUrl,
    LORE_RERANK_BASE_URL: `http://127.0.0.1:${configuration.reranker.port}`,
    LORE_RERANK_CANDIDATE_LIMIT: configuredValue(environment, "LORE_RERANK_CANDIDATE_LIMIT", "20"),
    LORE_RERANK_DIVERSITY_LAMBDA: configuredValue(environment, "LORE_RERANK_DIVERSITY_LAMBDA", "1"),
    LORE_RERANK_MIN_SCORE: configuredValue(environment, "LORE_RERANK_MIN_SCORE", "0.01"),
    LORE_RERANK_MODEL: configuration.reranker.model,
    LORE_RERANK_PROVIDER: configuration.searchMode === "rerank" ? "llamacpp" : "",
    LORE_RERANK_TIMEOUT_MS: configuredValue(environment, "LORE_RERANK_TIMEOUT_MS", "120000"),
    LORE_RERANK_WEIGHT: configuredValue(environment, "LORE_RERANK_WEIGHT", "0.75"),
    LORE_SEMANTIC_DISTANCE_THRESHOLD: configuredValue(
      environment,
      "LORE_SEMANTIC_DISTANCE_THRESHOLD",
      "0.5",
    ),
    PORT: String(configuration.appPort),
  };
  for (const name of [
    ...bootstrapSecretSettings,
    "LORE_LOCAL_POSTGRES_ADMIN_URL",
    "LORE_MAINTENANCE_DATABASE_URL",
    "LORE_MAINTENANCE_PASSWORD",
    "LORE_RUNTIME_PASSWORD",
  ]) {
    delete runtime[name];
  }
  return runtime;
}

export function buildMaintenanceEnvironment(environment, configuration) {
  const runtime = {
    ...environment,
    LORE_MAINTENANCE_DATABASE_URL: configuration.database.maintenanceUrl,
  };
  for (const name of [
    ...bootstrapSecretSettings,
    "DATABASE_URL",
    "LORE_LOCAL_POSTGRES_ADMIN_URL",
    "LORE_MAINTENANCE_PASSWORD",
    "LORE_RUNTIME_PASSWORD",
  ]) {
    delete runtime[name];
  }
  return runtime;
}

function buildRerankerEnvironment(environment) {
  const runtime = { ...environment };
  for (const name of [
    ...bootstrapSecretSettings,
    "DATABASE_URL",
    "LORE_LOCAL_POSTGRES_ADMIN_URL",
    "LORE_MAINTENANCE_DATABASE_URL",
    "LORE_MAINTENANCE_PASSWORD",
    "LORE_RUNTIME_PASSWORD",
  ]) {
    delete runtime[name];
  }
  return runtime;
}

function generatedCredentials(secret) {
  return {
    adminPassword: secret(),
    requestPassword: secret(),
    maintenancePassword: secret(),
  };
}

function nativeSettings(credentials) {
  return new Map([
    ["LORE_LOCAL_SEARCH_MODE", "hybrid"],
    ["LORE_LOCAL_POSTGRES_ADMIN_URL", "postgresql:///postgres"],
    ["LORE_LOCAL_POSTGRES_DATABASE", "lore"],
    ["LORE_RUNTIME_ROLE", "lore_local_runtime"],
    ["LORE_RUNTIME_PASSWORD", credentials.requestPassword],
    ["LORE_MAINTENANCE_ROLE", "lore_local_maintenance_runtime"],
    ["LORE_MAINTENANCE_PASSWORD", credentials.maintenancePassword],
    [
      "DATABASE_URL",
      `postgresql://lore_local_runtime:${credentials.requestPassword}@127.0.0.1:5432/lore`,
    ],
    [
      "LORE_MAINTENANCE_DATABASE_URL",
      `postgresql://lore_local_maintenance_runtime:${credentials.maintenancePassword}@127.0.0.1:5432/lore`,
    ],
  ]);
}

export function renderLocalEnvironment(
  example,
  secret = () => randomBytes(24).toString("base64url"),
) {
  const credentials = generatedCredentials(secret);
  let rendered = example;
  const replacements = new Map([
    [
      "LORE_DB_ADMIN_PASSWORD=change-this-admin-password",
      `LORE_DB_ADMIN_PASSWORD=${credentials.adminPassword}`,
    ],
    [
      "LORE_DB_RUNTIME_PASSWORD=change-this-runtime-password",
      `LORE_DB_RUNTIME_PASSWORD=${credentials.requestPassword}`,
    ],
    [
      "LORE_DB_MAINTENANCE_PASSWORD=change-this-maintenance-password",
      `LORE_DB_MAINTENANCE_PASSWORD=${credentials.maintenancePassword}`,
    ],
  ]);
  for (const [placeholder, replacement] of replacements) {
    if (!rendered.includes(placeholder)) {
      throw new Error(`Missing expected .env.example placeholder ${placeholder}`);
    }
    rendered = rendered.replace(placeholder, replacement);
  }

  const settings = [...nativeSettings(credentials)].map(([name, value]) => `${name}=${value}`);
  return `${rendered.trimEnd()}\n\n# Native one-command local service.\n${settings.join("\n")}\n`;
}

export function extendLocalEnvironment(
  existing,
  secret = () => randomBytes(24).toString("base64url"),
) {
  const parsed = parseEnv(existing);
  const presentDatabaseSettings = nativeDatabaseSettings.filter((name) => parsed[name]?.trim());
  if (presentDatabaseSettings.length === nativeDatabaseSettings.length) return existing;
  if (presentDatabaseSettings.length > 0) {
    const missing = nativeDatabaseSettings.filter((name) => !parsed[name]?.trim());
    throw new Error(
      `Existing .env has partial native service configuration; add ${missing.join(", ")}`,
    );
  }

  const credentials = generatedCredentials(secret);
  let rendered = existing;
  const placeholders = new Map([
    [
      "LORE_DB_ADMIN_PASSWORD=change-this-admin-password",
      `LORE_DB_ADMIN_PASSWORD=${credentials.adminPassword}`,
    ],
    [
      "LORE_DB_RUNTIME_PASSWORD=change-this-runtime-password",
      `LORE_DB_RUNTIME_PASSWORD=${credentials.requestPassword}`,
    ],
    [
      "LORE_DB_MAINTENANCE_PASSWORD=change-this-maintenance-password",
      `LORE_DB_MAINTENANCE_PASSWORD=${credentials.maintenancePassword}`,
    ],
  ]);
  for (const [placeholder, replacement] of placeholders) {
    rendered = rendered.replace(placeholder, replacement);
  }
  const settings = [...nativeSettings(credentials)]
    .filter(([name]) => !parsed[name]?.trim())
    .map(([name, value]) => `${name}=${value}`);
  return `${rendered.trimEnd()}\n\n# Native one-command local service.\n${settings.join("\n")}\n`;
}

function initializeEnvironment() {
  if (!existsSync(environmentPath)) {
    const example = readFileSync(environmentExamplePath, "utf8");
    writeFileSync(environmentPath, renderLocalEnvironment(example), { mode: 0o600 });
    console.log("Created .env with unique local Postgres runtime credentials.");
    return true;
  }
  const existing = readFileSync(environmentPath, "utf8");
  const extended = extendLocalEnvironment(existing);
  if (extended === existing) {
    chmodSync(environmentPath, 0o600);
    return false;
  }
  writeFileSync(environmentPath, extended, { mode: 0o600 });
  chmodSync(environmentPath, 0o600);
  console.log("Extended existing .env with unique local Postgres runtime credentials.");
  return true;
}

function loadEnvironment() {
  const fileEnvironment = existsSync(environmentPath)
    ? parseEnv(readFileSync(environmentPath, "utf8"))
    : {};
  return { ...fileEnvironment, ...process.env };
}

function statePath(name) {
  return join(stateDirectory, `${name}.json`);
}

function logPath(name) {
  return join(stateDirectory, `${name}.log`);
}

function secureManagedFiles() {
  for (const name of managedProcessNames) {
    for (const path of [statePath(name), logPath(name)]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }
}

function commandWorks(command, arguments_) {
  const result = spawnSync(command, arguments_, { cwd: repositoryRoot, stdio: "ignore" });
  return !result.error && result.status === 0;
}

async function run(command, arguments_, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        reject(
          new Error(
            `${command} ${arguments_.join(" ")} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
          ),
        );
      }
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function endpointIsHealthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForEndpoint(url, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await endpointIsHealthy(url)) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function readState(name) {
  const path = statePath(name);
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (
      !Number.isInteger(state.pid) ||
      state.pid < 1 ||
      typeof state.command !== "string" ||
      !Array.isArray(state.matchTokens)
    ) {
      throw new Error("invalid state");
    }
    return state;
  } catch {
    rmSync(path, { force: true });
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processMatchesState(state) {
  if (!processIsAlive(state.pid)) return false;
  const result = spawnSync("ps", ["-p", String(state.pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout.includes(basename(state.command))) return false;
  return state.matchTokens.every((token) => result.stdout.includes(token));
}

async function stopManagedProcess(name, { quiet = false } = {}) {
  const state = readState(name);
  if (!state) {
    if (!quiet) console.log(`${name}: not managed by this Lore service`);
    return false;
  }
  if (!processMatchesState(state)) {
    rmSync(statePath(name), { force: true });
    if (!quiet) console.log(`${name}: removed stale state; no process was stopped`);
    return false;
  }

  try {
    process.kill(-state.pid, "SIGTERM");
  } catch {
    process.kill(state.pid, "SIGTERM");
  }
  const deadline = Date.now() + 5_000;
  while (processIsAlive(state.pid) && Date.now() < deadline) await delay(100);
  if (processIsAlive(state.pid)) {
    try {
      process.kill(-state.pid, "SIGKILL");
    } catch {
      process.kill(state.pid, "SIGKILL");
    }
  }
  rmSync(statePath(name), { force: true });
  if (!quiet) console.log(`${name}: stopped`);
  return true;
}

async function startManagedProcess(definition) {
  const existingState = readState(definition.name);
  const managed = existingState && processMatchesState(existingState);
  const healthy = definition.healthUrl ? await endpointIsHealthy(definition.healthUrl) : false;

  if (managed && (!definition.healthUrl || healthy)) {
    console.log(`${definition.name}: already running (pid ${existingState.pid})`);
    return false;
  }
  if (healthy && !managed) {
    if (definition.allowExternal) {
      if (existingState) rmSync(statePath(definition.name), { force: true });
      console.log(`${definition.name}: reusing healthy external process`);
      return false;
    }
    throw new Error(`${definition.name} endpoint is already occupied by an unmanaged process`);
  }
  if (managed) {
    throw new Error(`${definition.name} process ${existingState.pid} is alive but unhealthy`);
  }
  if (existingState) rmSync(statePath(definition.name), { force: true });

  mkdirSync(stateDirectory, { recursive: true });
  const processLogPath = logPath(definition.name);
  const descriptor = openSync(processLogPath, "a", 0o600);
  chmodSync(processLogPath, 0o600);
  let child;
  try {
    child = spawn(definition.command, definition.arguments, {
      cwd: repositoryRoot,
      detached: true,
      env: definition.environment,
      stdio: ["ignore", descriptor, descriptor],
    });
    await new Promise((resolvePromise, reject) => {
      child.once("spawn", resolvePromise);
      child.once("error", reject);
    });
  } finally {
    closeSync(descriptor);
  }
  child.unref();
  writeFileSync(
    statePath(definition.name),
    `${JSON.stringify(
      {
        arguments: definition.arguments,
        command: definition.command,
        matchTokens: definition.matchTokens,
        pid: child.pid,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  try {
    if (definition.healthUrl) {
      await waitForEndpoint(definition.healthUrl, definition.startTimeoutMs);
    } else {
      await delay(750);
      const state = readState(definition.name);
      if (!state || !processMatchesState(state)) throw new Error("process exited during startup");
    }
  } catch (error) {
    await stopManagedProcess(definition.name, { quiet: true });
    throw new Error(
      `${definition.name} failed to start: ${error.message}. Inspect ${logPath(definition.name)}`,
    );
  }
  console.log(`${definition.name}: started (pid ${child.pid})`);
  return true;
}

async function ensureOllama(environment) {
  const embeddingProvider = configuredValue(environment, "LORE_EMBEDDING_PROVIDER", "ollama");
  if (embeddingProvider !== "ollama") return;
  const ollamaUrl = configuredValue(environment, "OLLAMA_BASE_URL", "http://127.0.0.1:11434");
  const tagsUrl = `${ollamaUrl.replace(/\/$/, "")}/api/tags`;
  let response;
  try {
    response = await fetch(tagsUrl, { signal: AbortSignal.timeout(2_000) });
  } catch {
    throw new Error(`Ollama is unavailable at ${ollamaUrl}. Start Ollama before Lore.`);
  }
  if (!response.ok) throw new Error(`Ollama health check failed with HTTP ${response.status}`);
  const payload = await response.json();
  const embeddingModel = configuredValue(
    environment,
    "LORE_EMBEDDING_MODEL",
    "qwen3-embedding:0.6b",
  );
  const installed = Array.isArray(payload.models)
    ? payload.models.some(
        (model) => model?.name === embeddingModel || model?.model === embeddingModel,
      )
    : false;
  if (!installed) {
    throw new Error(`Ollama does not have ${embeddingModel}. Run "ollama pull ${embeddingModel}".`);
  }
}

async function ensureDatabase(configuration, environment) {
  const admin = new pg.Client({ connectionString: configuration.database.adminUrl });
  await admin.connect();
  try {
    const result = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      configuration.database.name,
    ]);
    if (!result.rowCount) {
      await admin.query(`CREATE DATABASE "${configuration.database.name}"`);
      console.log(`postgres: created database ${configuration.database.name}`);
    }
  } finally {
    await admin.end();
  }

  const ownerUrl = targetDatabaseUrl(configuration.database.adminUrl, configuration.database.name);
  await run("node", ["scripts/migrate.mjs"], {
    env: { ...environment, DATABASE_URL: ownerUrl },
  });
  await run("node", ["scripts/create-runtime-role.mjs"], {
    env: {
      ...environment,
      DATABASE_URL: ownerUrl,
      LORE_MAINTENANCE_PASSWORD: configuration.database.maintenancePassword,
      LORE_MAINTENANCE_ROLE: configuration.database.maintenanceRole,
      LORE_RUNTIME_PASSWORD: configuration.database.requestPassword,
      LORE_RUNTIME_ROLE: configuration.database.requestRole,
    },
  });
  console.log(`postgres: ready (${configuration.database.name})`);
}

async function up() {
  initializeEnvironment();
  secureManagedFiles();
  const environment = loadEnvironment();
  const configuration = localServiceConfiguration(environment);
  if (!commandWorks("bun", ["--version"])) throw new Error("Bun is unavailable");
  if (
    configuration.searchMode === "rerank" &&
    !commandWorks(configuration.reranker.command, ["--version"])
  ) {
    throw new Error(
      `${configuration.reranker.command} is unavailable. Run "brew install llama.cpp".`,
    );
  }
  await ensureOllama(environment);
  await ensureDatabase(configuration, environment);
  await run("bun", ["run", "build:maintenance"], { env: environment });

  const runtimeEnvironment = buildRuntimeEnvironment(environment, configuration);
  const maintenanceEnvironment = buildMaintenanceEnvironment(environment, configuration);
  const rerankerEnvironment = buildRerankerEnvironment(environment);
  const started = [];
  try {
    if (
      configuration.searchMode === "rerank" &&
      (await startManagedProcess({
        allowExternal: true,
        arguments: buildRerankerArguments(configuration.reranker),
        command: configuration.reranker.command,
        environment: rerankerEnvironment,
        healthUrl: `http://127.0.0.1:${configuration.reranker.port}/health`,
        matchTokens: ["--reranking", configuration.reranker.model],
        name: "reranker",
        startTimeoutMs: configuration.reranker.startTimeoutMs,
      }))
    ) {
      started.push("reranker");
    }
    if (
      await startManagedProcess({
        arguments: [maintenanceWorkerPath],
        command: process.execPath,
        environment: maintenanceEnvironment,
        matchTokens: ["maintenance-worker.js"],
        name: "maintenance",
      })
    ) {
      started.push("maintenance");
    }
    if (
      await startManagedProcess({
        arguments: [
          nextBinPath,
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(configuration.appPort),
        ],
        command: process.execPath,
        environment: runtimeEnvironment,
        healthUrl: `http://127.0.0.1:${configuration.appPort}/livez`,
        matchTokens: ["next", "dev", String(configuration.appPort)],
        name: "app",
        startTimeoutMs: 120_000,
      })
    ) {
      started.push("app");
    }
  } catch (error) {
    for (const name of started.reverse()) await stopManagedProcess(name, { quiet: true });
    throw error;
  }
  console.log(
    `Lore is ready at http://127.0.0.1:${configuration.appPort} (${configuration.searchMode} search)`,
  );
}

async function down() {
  for (const name of managedProcessNames) await stopManagedProcess(name);
  console.log("postgres/ollama: left running (system-managed)");
}

async function databaseIsHealthy(url) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function status() {
  if (!existsSync(environmentPath)) {
    console.log("postgres: local service not initialized (.env is absent)");
    for (const name of managedProcessNames) console.log(`${name}: stopped`);
    return;
  }
  const environment = loadEnvironment();
  const configuration = localServiceConfiguration(environment);
  console.log(
    `postgres: ${(await databaseIsHealthy(configuration.database.requestUrl)) ? "healthy" : "unavailable"}`,
  );
  console.log(`search: ${configuration.searchMode}`);
  const endpoints = {
    app: `http://127.0.0.1:${configuration.appPort}/livez`,
    reranker: `http://127.0.0.1:${configuration.reranker.port}/health`,
  };
  for (const name of managedProcessNames) {
    const state = readState(name);
    const managed = state && processMatchesState(state);
    if (name === "reranker" && configuration.searchMode === "hybrid") {
      console.log(
        `reranker: disabled${managed ? ` (managed pid ${state.pid} still running; restart service)` : ""}`,
      );
      continue;
    }
    const healthy = endpoints[name] ? await endpointIsHealthy(endpoints[name]) : managed;
    const ownership = managed ? `managed pid ${state.pid}` : healthy ? "external" : "stopped";
    console.log(`${name}: ${healthy ? `healthy (${ownership})` : ownership}`);
  }
}

function logs() {
  for (const name of managedProcessNames) {
    const path = logPath(name);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    console.log(`\n=== ${name} (last 100 lines) ===`);
    console.log(lines.slice(-100).join("\n"));
  }
}

function usage() {
  console.log("Usage: node scripts/local-service.mjs <up|down|restart|status|logs>");
}

async function main() {
  const command = process.argv[2];
  if (command === "up") await up();
  else if (command === "down") await down();
  else if (command === "restart") {
    await down();
    await up();
  } else if (command === "status") await status();
  else if (command === "logs") logs();
  else {
    usage();
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`Local service failed: ${error.message}`);
    process.exitCode = 1;
  });
}
