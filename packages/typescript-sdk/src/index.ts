import type { components, operations, paths } from "./generated/openapi.js";
import { LORE_ERROR_CODES } from "./generated/runtime.js";

export type LoreOpenApiPaths = paths;
export type LoreOpenApiOperations = operations;
export type LoreOpenApiComponents = components;

type Schema<Name extends keyof components["schemas"]> = components["schemas"][Name];

export type Memory = Schema<"Memory">;
export type MemoryScope = Memory["scope"];
export type MemorySearchResult = Schema<"MemorySearchResult">;
export type CreateMemoryInput = Schema<"CreateMemoryInput">;
export type UpdateMemoryInput = Schema<"UpdateMemoryInput">;
export type Workspace = Schema<"Workspace">;
export type WorkspaceSummary = Schema<"WorkspaceSummary">;
export type MemoryGraph = Schema<"MemoryGraph">;
export type DeploymentCapabilities = Schema<"Capabilities">;
export type ReadinessReport = Schema<"ReadinessReport">;
export type LoreErrorCode = Schema<"Error">["code"];

export type LoreAuthentication =
  | { type: "agent"; token: string }
  | { type: "basic"; password: string; username?: string };

export type LoreGatewayAuthentication =
  | { type: "cloudflare-access-token"; token: string }
  | { type: "cloudflare-service-token"; clientId: string; clientSecret: string };

export interface LoreClientOptions {
  baseUrl: string | URL;
  /** Establishes the Lore Actor at the application boundary. */
  auth?: LoreAuthentication;
  /** Passes an outer identity-aware gateway before Lore resolves the Actor. */
  gateway?: LoreGatewayAuthentication;
  /** Additional trusted-proxy or deployment-specific headers. */
  headers?: HeadersInit;
  /** Required to send authentication over non-loopback plain HTTP. */
  allowInsecure?: boolean;
  /** Per-request timeout in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface LoreEnvironmentConfiguration {
  client: LoreClientOptions;
  workspaceId?: string;
}

export interface MemoryListInput {
  cursor?: string;
  limit?: number;
  metadata?: Record<string, unknown>;
  offset?: number;
  scope?: MemoryScope;
  updatedAfter?: string;
  updatedBefore?: string;
  signal?: AbortSignal;
}

export interface MemorySearchInput {
  limit?: number;
  metadata?: Record<string, unknown>;
  query: string;
  scope?: MemoryScope;
  updatedAfter?: string;
  updatedBefore?: string;
  signal?: AbortSignal;
}

export interface MemoryPage {
  memories: readonly Memory[];
  nextCursor: string | null;
}

export interface MutationOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface VersionedMutationOptions extends MutationOptions {
  expectedVersion: number;
}

export class LoreApiError extends Error {
  override name = "LoreApiError";

  constructor(
    message: string,
    readonly status: number,
    readonly code: LoreErrorCode | "http_error" | "invalid_response" | "transport_error",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const MAX_SUCCESS_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const AGENT_TOKEN_PATTERN = /^lore_agent_[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LORE_ERROR_CODE_SET = new Set<string>(LORE_ERROR_CODES);
const RESERVED_CUSTOM_HEADERS = new Set([
  "authorization",
  "cookie",
  "cf-access-jwt-assertion",
  "cf-access-token",
  "cf-access-client-id",
  "cf-access-client-secret",
  "proxy-authorization",
]);

function normalizedUuid(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new TypeError(`${name} must be a UUID`);
  return normalized;
}

function normalizedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new TypeError("limit must be an integer from 1 to 100");
  }
  return value;
}

function normalizedTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_REQUEST_TIMEOUT_MS) {
    throw new TypeError("timeoutMs must be an integer from 1 to 300000 milliseconds");
  }
  return value;
}

function normalizedBaseUrl(value: string | URL): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("Lore baseUrl must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("Lore baseUrl cannot contain credentials, a query, or a fragment");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function isLoopback(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function actorHeaders(auth: LoreAuthentication | undefined): Headers {
  const headers = new Headers();
  if (!auth) return headers;
  if (auth.type === "agent") {
    if (!AGENT_TOKEN_PATTERN.test(auth.token)) throw new TypeError("Lore Agent token is invalid");
    headers.set("authorization", `Bearer ${auth.token}`);
  } else {
    if (!auth.password || auth.password.length > 4_096) {
      throw new TypeError("Lore Basic password must contain 1 to 4096 characters");
    }
    headers.set("authorization", `Basic ${base64(`${auth.username ?? "lore"}:${auth.password}`)}`);
  }
  return headers;
}

function gatewayHeaders(auth: LoreGatewayAuthentication | undefined): Headers {
  const headers = new Headers();
  if (!auth) return headers;
  if (auth.type === "cloudflare-access-token") {
    if (!auth.token.trim() || auth.token.length > 16_384) {
      throw new TypeError("Cloudflare Access token is invalid");
    }
    headers.set("cf-access-token", auth.token);
  } else {
    if (!auth.clientId.trim() || auth.clientId.length > 4_096) {
      throw new TypeError("Cloudflare Access client id is invalid");
    }
    if (!auth.clientSecret.trim() || auth.clientSecret.length > 4_096) {
      throw new TypeError("Cloudflare Access client secret is invalid");
    }
    headers.set("cf-access-client-id", auth.clientId);
    headers.set("cf-access-client-secret", auth.clientSecret);
  }
  return headers;
}

function normalizedCustomHeaders(input: HeadersInit | undefined): Headers {
  const headers = new Headers(input);
  for (const name of headers.keys()) {
    if (RESERVED_CUSTOM_HEADERS.has(name.toLowerCase())) {
      throw new TypeError(`${name} must be configured through typed Lore client options`);
    }
  }
  return headers;
}

function normalizedIdempotencyKey(value: string | undefined): string {
  if (value === undefined) return crypto.randomUUID();
  if (!value || value.length > 128 || value.trim() !== value) {
    throw new TypeError("idempotencyKey must contain 1 to 128 characters without outer whitespace");
  }
  return value;
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new LoreApiError(
      `Lore response exceeds ${maximumBytes} bytes`,
      response.status,
      "invalid_response",
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new LoreApiError(
          `Lore response exceeds ${maximumBytes} bytes`,
          response.status,
          "invalid_response",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new LoreApiError("Lore returned invalid UTF-8", response.status, "invalid_response", {
      cause,
    });
  }
}

function parsedJson(text: string, response: Response): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new LoreApiError("Lore returned invalid JSON", response.status, "invalid_response", {
      cause,
    });
  }
}

interface RequestInput {
  acceptedStatuses?: readonly number[];
  body?: unknown;
  headers?: HeadersInit;
  method?: string;
  signal?: AbortSignal;
  workspaceId?: string;
}

interface JsonResponse<Result> {
  data: Result;
  response: Response;
}

function requestAbortSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  dispose: () => void;
  signal: AbortSignal;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let didTimeOut = false;
  const forwardCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardCallerAbort();
  else callerSignal?.addEventListener("abort", forwardCallerAbort, { once: true });
  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new DOMException("Lore request timed out", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", forwardCallerAbort);
    },
  };
}

class LoreTransport {
  readonly baseUrl: URL;
  readonly fetch: typeof globalThis.fetch;
  readonly headers: Headers;
  readonly timeoutMs: number;

  constructor(options: LoreClientOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    const customHeaders = normalizedCustomHeaders(options.headers);
    if (
      (options.auth || options.gateway || Array.from(customHeaders).length > 0) &&
      this.baseUrl.protocol !== "https:" &&
      !isLoopback(this.baseUrl) &&
      options.allowInsecure !== true
    ) {
      throw new TypeError(
        "Lore authentication requires HTTPS outside loopback; set allowInsecure only for a trusted development network",
      );
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch !== "function") throw new TypeError("A Fetch implementation is required");
    this.headers = customHeaders;
    this.timeoutMs = normalizedTimeoutMs(options.timeoutMs);
    for (const [name, value] of actorHeaders(options.auth)) this.headers.set(name, value);
    for (const [name, value] of gatewayHeaders(options.gateway)) this.headers.set(name, value);
  }

  async json<Result>(path: string, input: RequestInput = {}): Promise<JsonResponse<Result>> {
    const headers = new Headers(this.headers);
    if (input.workspaceId) {
      headers.set("x-lore-workspace-id", normalizedUuid(input.workspaceId, "workspaceId"));
    }
    if (input.body !== undefined) headers.set("content-type", "application/json");
    for (const [name, value] of new Headers(input.headers)) headers.set(name, value);
    const requestAbort = requestAbortSignal(input.signal, this.timeoutMs);
    try {
      const response = await this.fetch(new URL(path, this.baseUrl), {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        redirect: "error",
        signal: requestAbort.signal,
      });
      if (response.status === 204) return { data: undefined as Result, response };
      const accepted = response.ok || input.acceptedStatuses?.includes(response.status) === true;
      const text = await readBoundedText(
        response,
        accepted ? MAX_SUCCESS_RESPONSE_BYTES : MAX_ERROR_RESPONSE_BYTES,
      );
      if (!accepted) {
        const payload = (() => {
          try {
            return JSON.parse(text) as { code?: unknown; error?: unknown };
          } catch {
            return {};
          }
        })();
        throw new LoreApiError(
          typeof payload.error === "string"
            ? payload.error
            : `Lore request failed (${response.status})`,
          response.status,
          typeof payload.code === "string" && LORE_ERROR_CODE_SET.has(payload.code)
            ? (payload.code as LoreErrorCode)
            : "http_error",
        );
      }
      return { data: parsedJson(text, response) as Result, response };
    } catch (error) {
      if (error instanceof LoreApiError) throw error;
      if (input.signal?.aborted) throw error;
      if (requestAbort.timedOut()) {
        throw new LoreApiError("Lore request timed out", 0, "transport_error", { cause: error });
      }
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new LoreApiError("Lore request could not be completed", 0, "transport_error", {
        cause: error,
      });
    } finally {
      requestAbort.dispose();
    }
  }
}

export class LoreClient {
  readonly #transport: LoreTransport;

  constructor(options: LoreClientOptions) {
    this.#transport = new LoreTransport(options);
  }

  async listWorkspaces(signal?: AbortSignal): Promise<readonly WorkspaceSummary[]> {
    return (
      await this.#transport.json<readonly WorkspaceSummary[]>("api/v1/workspaces", { signal })
    ).data;
  }

  async createWorkspace(name: string, signal?: AbortSignal): Promise<Workspace> {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 120) {
      throw new TypeError("Workspace name must contain 1 to 120 characters");
    }
    return (
      await this.#transport.json<Workspace>("api/v1/workspaces", {
        method: "POST",
        body: { name: normalizedName },
        signal,
      })
    ).data;
  }

  async readiness(signal?: AbortSignal): Promise<ReadinessReport> {
    return (
      await this.#transport.json<ReadinessReport>("readyz", {
        acceptedStatuses: [503],
        signal,
      })
    ).data;
  }

  workspace(workspaceId: string): LoreWorkspaceClient {
    return new LoreWorkspaceClient(this.#transport, normalizedUuid(workspaceId, "workspaceId"));
  }
}

export class LoreWorkspaceClient {
  constructor(
    private readonly transport: LoreTransport,
    readonly workspaceId: string,
  ) {}

  async capabilities(signal?: AbortSignal): Promise<DeploymentCapabilities> {
    return (
      await this.transport.json<DeploymentCapabilities>("api/v1/capabilities", {
        workspaceId: this.workspaceId,
        signal,
      })
    ).data;
  }

  async graph(limit = 5_000, signal?: AbortSignal): Promise<MemoryGraph> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      throw new TypeError("Graph limit must be an integer from 1 to 5000");
    }
    return (
      await this.transport.json<MemoryGraph>(`api/v1/graph?limit=${limit}`, {
        workspaceId: this.workspaceId,
        signal,
      })
    ).data;
  }

  async listMemories(input: MemoryListInput = {}): Promise<MemoryPage> {
    if (input.cursor && input.offset !== undefined) {
      throw new TypeError("cursor and offset cannot be combined");
    }
    const params = new URLSearchParams({ limit: String(normalizedLimit(input.limit, 50)) });
    if (input.cursor) params.set("cursor", input.cursor);
    if (input.offset !== undefined) {
      if (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 1_000_000) {
        throw new TypeError("offset must be an integer from 0 to 1000000");
      }
      params.set("offset", String(input.offset));
    }
    addMemoryFilters(params, input);
    const { data, response } = await this.transport.json<readonly Memory[]>(
      `api/v1/memories?${params}`,
      { workspaceId: this.workspaceId, signal: input.signal },
    );
    return { memories: data, nextCursor: response.headers.get("x-lore-next-cursor") };
  }

  async searchMemories(input: MemorySearchInput): Promise<readonly MemorySearchResult[]> {
    const query = input.query.trim();
    if (!query || query.length > 10_000) {
      throw new TypeError("query must contain 1 to 10000 characters");
    }
    const params = new URLSearchParams({
      q: query,
      limit: String(normalizedLimit(input.limit, 10)),
    });
    addMemoryFilters(params, input);
    return (
      await this.transport.json<readonly MemorySearchResult[]>(`api/v1/memories?${params}`, {
        workspaceId: this.workspaceId,
        signal: input.signal,
      })
    ).data;
  }

  async remember(input: CreateMemoryInput, options: MutationOptions = {}): Promise<Memory> {
    return (
      await this.transport.json<Memory>("api/v1/memories", {
        method: "POST",
        workspaceId: this.workspaceId,
        body: input,
        headers: { "idempotency-key": normalizedIdempotencyKey(options.idempotencyKey) },
        signal: options.signal,
      })
    ).data;
  }

  async getMemory(memoryId: string, signal?: AbortSignal): Promise<Memory> {
    return (
      await this.transport.json<Memory>(`api/v1/memories/${normalizedUuid(memoryId, "memoryId")}`, {
        workspaceId: this.workspaceId,
        signal,
      })
    ).data;
  }

  async updateMemory(
    memoryId: string,
    input: UpdateMemoryInput,
    options: VersionedMutationOptions,
  ): Promise<Memory> {
    const version = positiveVersion(options.expectedVersion);
    return (
      await this.transport.json<Memory>(`api/v1/memories/${normalizedUuid(memoryId, "memoryId")}`, {
        method: "PATCH",
        workspaceId: this.workspaceId,
        body: input,
        headers: {
          "if-match": `"memory-v${version}"`,
          "idempotency-key": normalizedIdempotencyKey(options.idempotencyKey),
        },
        signal: options.signal,
      })
    ).data;
  }

  async forgetMemory(memoryId: string, options: VersionedMutationOptions): Promise<void> {
    const version = positiveVersion(options.expectedVersion);
    await this.transport.json<void>(`api/v1/memories/${normalizedUuid(memoryId, "memoryId")}`, {
      method: "DELETE",
      workspaceId: this.workspaceId,
      headers: {
        "if-match": `"memory-v${version}"`,
        "idempotency-key": normalizedIdempotencyKey(options.idempotencyKey),
      },
      signal: options.signal,
    });
  }
}

function positiveVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("expectedVersion must be a positive integer");
  }
  return value;
}

function addMemoryFilters(
  params: URLSearchParams,
  input: Pick<MemoryListInput, "metadata" | "scope" | "updatedAfter" | "updatedBefore">,
): void {
  if (input.scope) params.set("scope", input.scope);
  if (input.updatedAfter) params.set("updated_after", input.updatedAfter);
  if (input.updatedBefore) params.set("updated_before", input.updatedBefore);
  if (input.metadata) params.set("metadata", JSON.stringify(input.metadata));
}

/** Resolve the shared CLI/MCP connection contract without reading global process state. */
export function loreConfigurationFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): LoreEnvironmentConfiguration {
  if (environment.LORE_ACCESS_JWT) {
    throw new TypeError(
      "LORE_ACCESS_JWT is not a client authentication header; use LORE_ACCESS_TOKEN or a Cloudflare service-token pair",
    );
  }
  const configuredActorAuth = [
    environment.LORE_AGENT_TOKEN ? "agent" : null,
    environment.LORE_BASIC_PASSWORD ? "basic" : null,
  ].filter((value): value is LoreAuthentication["type"] => value !== null);
  if (configuredActorAuth.length > 1) {
    throw new TypeError("Configure only one Lore Actor authentication mechanism");
  }
  const configuredGatewayAuth = [
    environment.LORE_ACCESS_TOKEN ? "cloudflare-access-token" : null,
    environment.LORE_ACCESS_CLIENT_ID || environment.LORE_ACCESS_CLIENT_SECRET
      ? "cloudflare-service-token"
      : null,
  ].filter((value): value is LoreGatewayAuthentication["type"] => value !== null);
  if (configuredGatewayAuth.length > 1) {
    throw new TypeError("Configure only one Lore gateway authentication mechanism");
  }
  const auth =
    configuredActorAuth[0] === "agent"
      ? ({ type: "agent", token: environment.LORE_AGENT_TOKEN ?? "" } as const)
      : configuredActorAuth[0] === "basic"
        ? ({
            type: "basic",
            username: environment.LORE_BASIC_USERNAME,
            password: environment.LORE_BASIC_PASSWORD ?? "",
          } as const)
        : undefined;
  const gateway =
    configuredGatewayAuth[0] === "cloudflare-access-token"
      ? ({
          type: "cloudflare-access-token",
          token: environment.LORE_ACCESS_TOKEN ?? "",
        } as const)
      : configuredGatewayAuth[0] === "cloudflare-service-token"
        ? ({
            type: "cloudflare-service-token",
            clientId: environment.LORE_ACCESS_CLIENT_ID ?? "",
            clientSecret: environment.LORE_ACCESS_CLIENT_SECRET ?? "",
          } as const)
        : undefined;
  const allowInsecureValue = environment.LORE_ALLOW_INSECURE?.trim().toLowerCase();
  if (allowInsecureValue && !["0", "1", "false", "true"].includes(allowInsecureValue)) {
    throw new TypeError("LORE_ALLOW_INSECURE must be 0, 1, false, or true");
  }
  return {
    client: {
      baseUrl: environment.LORE_URL?.trim() || "http://127.0.0.1:3000",
      auth,
      gateway,
      allowInsecure: allowInsecureValue === "1" || allowInsecureValue === "true",
    },
    workspaceId: environment.LORE_WORKSPACE_ID?.trim() || undefined,
  };
}
