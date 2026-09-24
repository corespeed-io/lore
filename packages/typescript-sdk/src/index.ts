import type { components, operations, paths } from "./generated/openapi.js";
import { LORE_ERROR_CODES } from "./generated/runtime.ts";

export type {
  RepositoryGroundingContext,
  RetrievalGroundingMode,
  RetrievalGroundingPlan,
  RetrievalGroundingQuery,
  RetrievalGroundingReasonCode,
} from "./generated/grounding.ts";
export {
  planRetrievalGrounding,
  RETRIEVAL_GROUNDING_POLICY_REVISION,
} from "./generated/grounding.ts";
/** Public input guidance; the API performs canonical content validation and chunking. */
export { MEMORY_CONTENT_LIMITS } from "./generated/runtime.ts";

export type LoreOpenApiPaths = paths;
export type LoreOpenApiOperations = operations;
export type LoreOpenApiComponents = components;

type Schema<Name extends keyof components["schemas"]> = components["schemas"][Name];

export type Memory = Schema<"Memory">;
export type MemoryScope = Memory["scope"];
export type MemorySearchResult = Schema<"MemorySearchResult">;
export type Episode = Schema<"Episode">;
export type EpisodeSummary = Schema<"EpisodeSummary">;
export type EpisodeKind = EpisodeSummary["kind"];
export type Observation = Schema<"Observation">;
export type ObservationKind = Observation["kind"];
export type RecordEpisodeInput = Schema<"RecordEpisodeInput">;
export type CreateMemoryInput = Schema<"CreateMemoryInput">;
export type UpdateMemoryInput = Schema<"UpdateMemoryInput">;
export type CreateMemoryProposalInput = Schema<"CreateMemoryProposalInput">;
export type MemoryProposal = Schema<"MemoryProposal">;
export type MemoryProposalCodeEvidence = Schema<"MemoryProposalCodeEvidence">;
export type ProposeMemoryCodeEvidenceInput = Schema<"ProposeMemoryCodeEvidenceInput">;
export type MemoryProposalStatus = MemoryProposal["status"];
export type MemoryProposalReviewResult = Schema<"MemoryProposalReviewResult">;
export type Workspace = Schema<"Workspace">;
export type WorkspaceSummary = Schema<"WorkspaceSummary">;
export type HumanActor = Schema<"HumanActor">;
export type WorkspaceAgent = Schema<"WorkspaceAgent">;
export type AgentCredential = Schema<"AgentCredential">;
export type IssuedAgentCredential = Schema<"IssuedAgentCredential">;
export type AgentWorkspaceGrant = Schema<"AgentWorkspaceGrant">;
export type UpdateAgentInput = Schema<"UpdateAgentInput">;
export type CreateAgentInput =
  operations["createAgent"]["requestBody"]["content"]["application/json"];
export type AgentGrantPermission = AgentWorkspaceGrant["permission"];
export type WorkspaceArchive = Schema<"WorkspaceArchive">;
export type ImportWorkspaceInput = Schema<"ImportWorkspaceInput">;
export type WorkspaceImportResult = Schema<"WorkspaceImportResult">;
export type MemoryGraph = Schema<"MemoryGraph">;
export type CodeArtifact = Schema<"CodeArtifact">;
export type CodeDependencyEdge = Schema<"CodeDependencyEdge">;
export type CodeDependencyQueryResult = Schema<"CodeDependencyQueryResult">;
export type CodeDependencyDirection = CodeDependencyQueryResult["direction"];
export type CodeIndexJob = Schema<"CodeIndexJob">;
export type EnqueueCodeIndexInput = Schema<"EnqueueCodeIndexInput">;
export type CiteMemoryCodeEvidenceInput = Schema<"CiteMemoryCodeEvidenceInput">;
export type MemoryCodeEvidence = Schema<"MemoryCodeEvidence">;
export type RevalidateMemoryCodeEvidenceInput = Schema<"RevalidateMemoryCodeEvidenceInput">;
export type RetrievedContext = Schema<"RetrievedContext">;
export type DeploymentCapabilities = Schema<"Capabilities">;
export type ReadinessReport = Schema<"ReadinessReport">;
export type LoreErrorCode = Schema<"Error">["code"];

export type LoreAuthentication =
  | { type: "agent"; token: string }
  | { type: "basic"; password: string; username?: string };

export type LoreGatewayAuthentication =
  | { type: "cloudflare-access-token"; token: string }
  | { type: "cloudflare-service-token"; clientId: string; clientSecret: string };

/** Request timing and outcome; operation labels omit identifiers and query parameters. */
export interface LoreRequestEvent {
  operation: string;
  at: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

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
  /** Per-request timeout in milliseconds. Defaults to 30 seconds; null disables it. */
  timeoutMs?: number | null;
  /** Browser cookie policy. Fetch defaults to same-origin when omitted. */
  credentials?: RequestCredentials;
  /** Called after response parsing. Caller cancellations are not reported. */
  onRequest?: (event: LoreRequestEvent) => void;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
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

export interface CodeSearchInput {
  commitOid: string;
  limit?: number;
  pathPrefix?: string;
  query: string;
  repositoryKey: string;
  signal?: AbortSignal;
}

export type ContextRetrievalRoute = NonNullable<Schema<"RetrieveContextInput">["route"]>;
export type RetrieveContextInput = Schema<"RetrieveContextInput"> & { signal?: AbortSignal };

export interface CodeDependencyQueryInput {
  commitOid: string;
  direction: CodeDependencyDirection;
  limit?: number;
  path?: string;
  repositoryKey: string;
  signal?: AbortSignal;
  symbol?: string;
}

export interface MemoryPage {
  memories: readonly Memory[];
  nextCursor: string | null;
}

export interface MemoryProposalListInput {
  limit?: number;
  signal?: AbortSignal;
  status?: MemoryProposalStatus;
}

export interface EpisodeListInput {
  cursor?: string;
  kind?: EpisodeKind;
  limit?: number;
  scope?: MemoryScope;
  signal?: AbortSignal;
}

export interface EpisodePage {
  episodes: readonly EpisodeSummary[];
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
/** The server's Idempotency-Key rule, checked here so callers see it before a 400. */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
/** RFC 9110 `token`: the grammar of a header name. */
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/**
 * RFC 9110 `field-value` characters: visible ASCII, spaces, tabs, and obs-text,
 * never CR, LF, NUL, or another control. Header values are checked against these
 * rules before they reach `Headers`, whose TypeError quotes the rejected value
 * (Bun's does), because the CLI and MCP adapter print that message to stderr.
 */
const HTTP_FIELD_VALUE_PATTERN = /^[\t\x20-\x7e\x80-\xff]*$/;
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

function normalizedLimit(value: number | undefined, fallback: number, maximum = 100): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`limit must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function normalizedTimeoutMs(value: number | null | undefined): number | null {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_REQUEST_TIMEOUT_MS) {
    throw new TypeError("timeoutMs must be an integer from 1 to 300000 milliseconds");
  }
  return value;
}

function normalizedBaseUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The parser's own message quotes the input, which may embed credentials.
    throw new TypeError("Lore baseUrl must be an absolute http or https URL");
  }
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

/**
 * A gateway credential without the outer whitespace `Headers` would strip. The
 * error names the setting, never the value, which is a secret.
 */
function gatewayCredential(value: string, maximumLength: number, name: string): string {
  const credential = value.trim();
  if (credential.length > maximumLength || !VISIBLE_ASCII_PATTERN.test(credential)) {
    throw new TypeError(`${name} must contain 1 to ${maximumLength} visible ASCII characters`);
  }
  return credential;
}

const ACCESS_TOKEN_MAXIMUM_LENGTH = 16_384;
const ACCESS_SERVICE_CREDENTIAL_MAXIMUM_LENGTH = 4_096;

function gatewayHeaders(auth: LoreGatewayAuthentication | undefined): Headers {
  const headers = new Headers();
  if (!auth) return headers;
  if (auth.type === "cloudflare-access-token") {
    headers.set(
      "cf-access-token",
      gatewayCredential(auth.token, ACCESS_TOKEN_MAXIMUM_LENGTH, "Cloudflare Access token"),
    );
  } else {
    headers.set(
      "cf-access-client-id",
      gatewayCredential(
        auth.clientId,
        ACCESS_SERVICE_CREDENTIAL_MAXIMUM_LENGTH,
        "Cloudflare Access client id",
      ),
    );
    headers.set(
      "cf-access-client-secret",
      gatewayCredential(
        auth.clientSecret,
        ACCESS_SERVICE_CREDENTIAL_MAXIMUM_LENGTH,
        "Cloudflare Access client secret",
      ),
    );
  }
  return headers;
}

function customHeaderEntries(input: HeadersInit): Array<readonly [string, string]> {
  if (input instanceof Headers) return [...input];
  if (!Array.isArray(input)) return Object.entries(input);
  return input.map((entry) => {
    const [name, value] = entry;
    if (entry.length !== 2 || name === undefined || value === undefined) {
      throw new TypeError("Lore custom headers must be name/value pairs");
    }
    return [name, value] as const;
  });
}

function normalizedCustomHeaders(input: HeadersInit | undefined): Headers {
  const headers = new Headers();
  if (input === undefined) return headers;
  for (const [name, value] of customHeaderEntries(input)) {
    if (!HTTP_TOKEN_PATTERN.test(name)) {
      throw new TypeError("Lore custom header names must be HTTP tokens");
    }
    if (RESERVED_CUSTOM_HEADERS.has(name.toLowerCase())) {
      throw new TypeError(`${name} must be configured through typed Lore client options`);
    }
    if (!HTTP_FIELD_VALUE_PATTERN.test(value)) {
      throw new TypeError(`Lore custom header ${name} must have a valid HTTP field value`);
    }
    headers.append(name, value);
  }
  return headers;
}

function normalizedIdempotencyKey(value: string | undefined): string {
  if (value === undefined) return crypto.randomUUID();
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new TypeError("idempotencyKey must contain 1 to 128 visible ASCII characters");
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
  maximumResponseBytes?: number;
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
  timeoutMs: number | null,
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
  const timeout =
    timeoutMs === null
      ? undefined
      : setTimeout(() => {
          didTimeOut = true;
          controller.abort(new DOMException("Lore request timed out", "TimeoutError"));
        }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      if (timeout !== undefined) clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", forwardCallerAbort);
    },
  };
}

class LoreTransport {
  readonly baseUrl: URL;
  readonly fetch: NonNullable<LoreClientOptions["fetch"]>;
  readonly headers: Headers;
  readonly timeoutMs: number | null;
  readonly credentials: RequestCredentials | undefined;
  readonly onRequest: ((event: LoreRequestEvent) => void) | undefined;

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
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new TypeError("A Fetch implementation is required");
    // Call it detached: browsers reject window.fetch invoked with any other receiver
    // ("Illegal invocation"), and this.fetch(...) would make the transport the receiver.
    this.fetch = (input, init) => fetchImpl(input, init);
    this.headers = customHeaders;
    this.timeoutMs = normalizedTimeoutMs(options.timeoutMs);
    this.credentials = options.credentials;
    this.onRequest = options.onRequest;
    for (const [name, value] of actorHeaders(options.auth)) this.headers.set(name, value);
    for (const [name, value] of gatewayHeaders(options.gateway)) this.headers.set(name, value);
  }

  async json<Result>(path: string, input: RequestInput = {}): Promise<JsonResponse<Result>> {
    const at = Date.now();
    const operation = `${input.method ?? "GET"} /${path.split("?")[0]?.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ":id")}`;
    let outcome: { ok: boolean; error?: string } | undefined;
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
        ...(this.credentials === undefined ? {} : { credentials: this.credentials }),
        signal: requestAbort.signal,
      });
      if (response.status === 204) {
        outcome = { ok: true };
        return { data: undefined as Result, response };
      }
      const accepted = response.ok || input.acceptedStatuses?.includes(response.status) === true;
      const text = await readBoundedText(
        response,
        accepted
          ? (input.maximumResponseBytes ?? MAX_SUCCESS_RESPONSE_BYTES)
          : MAX_ERROR_RESPONSE_BYTES,
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
      const data = parsedJson(text, response) as Result;
      outcome = { ok: true };
      return { data, response };
    } catch (error) {
      if (
        !input.signal?.aborted &&
        !(error instanceof Error && error.name === "AbortError" && !requestAbort.timedOut())
      ) {
        outcome = {
          ok: false,
          error:
            error instanceof LoreApiError
              ? error.message
              : requestAbort.timedOut()
                ? "Lore request timed out"
                : "Lore request could not be completed",
        };
      }
      if (error instanceof LoreApiError) throw error;
      if (input.signal?.aborted) throw error;
      if (requestAbort.timedOut()) {
        throw new LoreApiError("Lore request timed out", 0, "transport_error", { cause: error });
      }
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new LoreApiError("Lore request could not be completed", 0, "transport_error", {
        cause: error,
      });
    } finally {
      requestAbort.dispose();
      if (outcome && this.onRequest) {
        try {
          this.onRequest({ operation, at, latencyMs: Date.now() - at, ...outcome });
        } catch {
          // Observability must not change the result of an API request.
        }
      }
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

  async getCurrentHumanActor(signal?: AbortSignal): Promise<HumanActor> {
    return (
      await this.transport.json<HumanActor>("api/v1/actor", {
        workspaceId: this.workspaceId,
        signal,
      })
    ).data;
  }

  async listAgents(signal?: AbortSignal): Promise<readonly WorkspaceAgent[]> {
    return (
      await this.transport.json<readonly WorkspaceAgent[]>("api/v1/agents", {
        workspaceId: this.workspaceId,
        signal,
      })
    ).data;
  }

  async createAgent(input: CreateAgentInput, signal?: AbortSignal): Promise<WorkspaceAgent> {
    return (
      await this.transport.json<WorkspaceAgent>("api/v1/agents", {
        method: "POST",
        workspaceId: this.workspaceId,
        body: input,
        signal,
      })
    ).data;
  }

  async updateAgent(
    agentId: string,
    input: UpdateAgentInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceAgent> {
    return (
      await this.transport.json<WorkspaceAgent>(
        `api/v1/agents/${normalizedUuid(agentId, "agentId")}`,
        { method: "PATCH", workspaceId: this.workspaceId, body: input, signal },
      )
    ).data;
  }

  async deleteAgent(agentId: string, signal?: AbortSignal): Promise<void> {
    await this.transport.json<void>(`api/v1/agents/${normalizedUuid(agentId, "agentId")}`, {
      method: "DELETE",
      workspaceId: this.workspaceId,
      signal,
    });
  }

  async listAgentCredentials(
    agentId: string,
    signal?: AbortSignal,
  ): Promise<readonly AgentCredential[]> {
    return (
      await this.transport.json<readonly AgentCredential[]>(
        `api/v1/agents/${normalizedUuid(agentId, "agentId")}/credentials`,
        { workspaceId: this.workspaceId, signal },
      )
    ).data;
  }

  async issueAgentCredential(
    agentId: string,
    signal?: AbortSignal,
  ): Promise<IssuedAgentCredential> {
    return (
      await this.transport.json<IssuedAgentCredential>(
        `api/v1/agents/${normalizedUuid(agentId, "agentId")}/credentials`,
        { method: "POST", workspaceId: this.workspaceId, signal },
      )
    ).data;
  }

  async revokeAgentCredential(credentialId: string, signal?: AbortSignal): Promise<void> {
    await this.transport.json<void>(
      `api/v1/agent-credentials/${normalizedUuid(credentialId, "credentialId")}`,
      { method: "DELETE", workspaceId: this.workspaceId, signal },
    );
  }

  async setAgentGrant(
    agentId: string,
    permission: AgentGrantPermission,
    signal?: AbortSignal,
  ): Promise<AgentWorkspaceGrant> {
    return (
      await this.transport.json<AgentWorkspaceGrant>(
        `api/v1/agents/${normalizedUuid(agentId, "agentId")}/grant`,
        { method: "PUT", workspaceId: this.workspaceId, body: { permission }, signal },
      )
    ).data;
  }

  async revokeAgentGrant(agentId: string, signal?: AbortSignal): Promise<void> {
    await this.transport.json<void>(`api/v1/agents/${normalizedUuid(agentId, "agentId")}/grant`, {
      method: "DELETE",
      workspaceId: this.workspaceId,
      signal,
    });
  }

  async exportWorkspace(signal?: AbortSignal): Promise<WorkspaceArchive> {
    return (
      await this.transport.json<WorkspaceArchive>("api/v1/workspaces/export", {
        workspaceId: this.workspaceId,
        signal,
        // Archive sizes are bounded by the server's record limits, not the ordinary JSON cap.
        maximumResponseBytes: Number.POSITIVE_INFINITY,
      })
    ).data;
  }

  async importWorkspace(
    input: ImportWorkspaceInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceImportResult> {
    return (
      await this.transport.json<WorkspaceImportResult>("api/v1/workspaces/import", {
        method: "POST",
        workspaceId: this.workspaceId,
        body: input,
        signal,
      })
    ).data;
  }

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

  async searchCode(input: CodeSearchInput): Promise<readonly CodeArtifact[]> {
    const repositoryKey = input.repositoryKey.trim();
    const commitOid = input.commitOid.trim().toLowerCase();
    const query = input.query.trim();
    if (!repositoryKey || repositoryKey.length > 512) {
      throw new TypeError("repositoryKey must contain 1 to 512 characters");
    }
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commitOid)) {
      throw new TypeError("commitOid must be a full 40- or 64-character Git OID");
    }
    if (!query || query.length > 2_000) {
      throw new TypeError("query must contain 1 to 2000 characters");
    }
    const params = new URLSearchParams({
      repository_key: repositoryKey,
      commit_oid: commitOid,
      q: query,
      limit: String(normalizedLimit(input.limit, 10)),
    });
    if (input.pathPrefix) params.set("path_prefix", input.pathPrefix);
    return (
      await this.transport.json<readonly CodeArtifact[]>(`api/v1/code/search?${params}`, {
        workspaceId: this.workspaceId,
        signal: input.signal,
      })
    ).data;
  }

  async retrieveContext(input: RetrieveContextInput): Promise<RetrievedContext> {
    const query = input.query.trim();
    if (!query || query.length > 10_000) {
      throw new TypeError("query must contain 1 to 10000 characters");
    }
    const repositoryKey = input.repositoryKey?.trim();
    const commitOid = input.commitOid?.trim().toLowerCase();
    if ((repositoryKey === undefined) !== (commitOid === undefined)) {
      throw new TypeError("repositoryKey and commitOid must be provided together");
    }
    if (repositoryKey !== undefined && (!repositoryKey || repositoryKey.length > 512)) {
      throw new TypeError("repositoryKey must contain 1 to 512 characters");
    }
    if (commitOid !== undefined && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commitOid)) {
      throw new TypeError("commitOid must be a full 40- or 64-character Git OID");
    }
    const route = input.route ?? "auto";
    if (!(["auto", "both", "code-only", "memory-only"] as const).includes(route)) {
      throw new TypeError("route is invalid");
    }
    if ((route === "both" || route === "code-only") && repositoryKey === undefined) {
      throw new TypeError(`${route} requires repositoryKey and commitOid`);
    }
    if (input.pathPrefix !== undefined && repositoryKey === undefined) {
      throw new TypeError("pathPrefix requires repositoryKey and commitOid");
    }
    if (input.codeQuery !== undefined && repositoryKey === undefined) {
      throw new TypeError("codeQuery requires repositoryKey and commitOid");
    }
    const memoryQuery = input.memoryQuery?.trim();
    if (memoryQuery !== undefined && (!memoryQuery || memoryQuery.length > 10_000)) {
      throw new TypeError("memoryQuery must contain 1 to 10000 characters");
    }
    const codeQuery = input.codeQuery?.trim();
    if (codeQuery !== undefined && (!codeQuery || codeQuery.length > 2_000)) {
      throw new TypeError("codeQuery must contain 1 to 2000 characters");
    }
    const { signal, ...requestInput } = input;
    return (
      await this.transport.json<RetrievedContext>("api/v1/context/retrieve", {
        method: "POST",
        workspaceId: this.workspaceId,
        body: {
          ...requestInput,
          query,
          ...(memoryQuery === undefined ? {} : { memoryQuery }),
          ...(codeQuery === undefined ? {} : { codeQuery }),
          ...(repositoryKey === undefined ? {} : { repositoryKey, commitOid }),
          route,
          memoryLimit: normalizedLimit(input.memoryLimit, 5, 10),
          codeLimit: normalizedLimit(input.codeLimit, 10, 20),
        },
        signal,
      })
    ).data;
  }

  async queryCodeDependencies(input: CodeDependencyQueryInput): Promise<CodeDependencyQueryResult> {
    const repositoryKey = input.repositoryKey.trim();
    const commitOid = input.commitOid.trim().toLowerCase();
    if (!repositoryKey || repositoryKey.length > 512) {
      throw new TypeError("repositoryKey must contain 1 to 512 characters");
    }
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commitOid)) {
      throw new TypeError("commitOid must be a full 40- or 64-character Git OID");
    }
    if (input.direction !== "callers" && input.direction !== "callees") {
      throw new TypeError("direction must be callers or callees");
    }
    if ((input.symbol === undefined) === (input.path === undefined)) {
      throw new TypeError("Provide exactly one of symbol or path");
    }
    const params = new URLSearchParams({
      repository_key: repositoryKey,
      commit_oid: commitOid,
      direction: input.direction,
    });
    if (input.symbol !== undefined) {
      const symbol = input.symbol.trim();
      if (!symbol || symbol.length > 1_600) {
        throw new TypeError("symbol must contain 1 to 1600 characters");
      }
      params.set("symbol", symbol);
    } else {
      const path = input.path ?? "";
      if (
        !path ||
        path !== path.trim() ||
        path.length > 1_024 ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").some((part) => !part || part === "." || part === "..")
      ) {
        throw new TypeError("path is invalid");
      }
      params.set("path", path);
    }
    params.set("limit", String(normalizedLimit(input.limit, 50, 200)));
    return (
      await this.transport.json<CodeDependencyQueryResult>(`api/v1/code/dependencies?${params}`, {
        workspaceId: this.workspaceId,
        signal: input.signal,
      })
    ).data;
  }

  async getCodeIndexJob(jobId: string, signal?: AbortSignal): Promise<CodeIndexJob> {
    return (
      await this.transport.json<CodeIndexJob>(
        `api/v1/code/index-jobs/${normalizedUuid(jobId, "jobId")}`,
        { workspaceId: this.workspaceId, signal },
      )
    ).data;
  }

  async listCodeIndexJobs(
    input: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<readonly CodeIndexJob[]> {
    const params = new URLSearchParams({ limit: String(normalizedLimit(input.limit, 20, 100)) });
    return (
      await this.transport.json<readonly CodeIndexJob[]>(`api/v1/code/index-jobs?${params}`, {
        workspaceId: this.workspaceId,
        signal: input.signal,
      })
    ).data;
  }

  async enqueueCodeIndex(
    input: EnqueueCodeIndexInput,
    signal?: AbortSignal,
  ): Promise<CodeIndexJob> {
    return (
      await this.transport.json<CodeIndexJob>("api/v1/code/index-jobs", {
        method: "POST",
        workspaceId: this.workspaceId,
        body: input,
        signal,
      })
    ).data;
  }

  async listMemoryCodeEvidence(
    memoryId: string,
    signal?: AbortSignal,
  ): Promise<readonly MemoryCodeEvidence[]> {
    return (
      await this.transport.json<readonly MemoryCodeEvidence[]>(
        `api/v1/memories/${normalizedUuid(memoryId, "memoryId")}/code-evidence`,
        { workspaceId: this.workspaceId, signal },
      )
    ).data;
  }

  async citeMemoryCodeEvidence(
    memoryId: string,
    input: CiteMemoryCodeEvidenceInput,
    signal?: AbortSignal,
  ): Promise<MemoryCodeEvidence> {
    return (
      await this.transport.json<MemoryCodeEvidence>(
        `api/v1/memories/${normalizedUuid(memoryId, "memoryId")}/code-evidence`,
        { method: "POST", workspaceId: this.workspaceId, body: input, signal },
      )
    ).data;
  }

  async revalidateMemoryCodeEvidence(
    evidenceId: string,
    input: RevalidateMemoryCodeEvidenceInput,
    signal?: AbortSignal,
  ): Promise<MemoryCodeEvidence> {
    return (
      await this.transport.json<MemoryCodeEvidence>(
        `api/v1/code-evidence/${normalizedUuid(evidenceId, "evidenceId")}/revalidate`,
        { method: "POST", workspaceId: this.workspaceId, body: input, signal },
      )
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

  async listEpisodes(input: EpisodeListInput = {}): Promise<EpisodePage> {
    const params = new URLSearchParams({ limit: String(normalizedLimit(input.limit, 50)) });
    if (input.cursor) params.set("cursor", input.cursor);
    if (input.kind) params.set("kind", input.kind);
    if (input.scope) params.set("scope", input.scope);
    const { data, response } = await this.transport.json<readonly EpisodeSummary[]>(
      `api/v1/episodes?${params}`,
      { workspaceId: this.workspaceId, signal: input.signal },
    );
    return { episodes: data, nextCursor: response.headers.get("x-lore-next-cursor") };
  }

  async recordEpisode(input: RecordEpisodeInput, options: MutationOptions = {}): Promise<Episode> {
    return (
      await this.transport.json<Episode>("api/v1/episodes", {
        method: "POST",
        workspaceId: this.workspaceId,
        body: input,
        headers: { "idempotency-key": normalizedIdempotencyKey(options.idempotencyKey) },
        signal: options.signal,
      })
    ).data;
  }

  async getEpisode(episodeId: string, signal?: AbortSignal): Promise<Episode> {
    return (
      await this.transport.json<Episode>(
        `api/v1/episodes/${normalizedUuid(episodeId, "episodeId")}`,
        { workspaceId: this.workspaceId, signal },
      )
    ).data;
  }

  async getObservations(
    observationIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly Observation[]> {
    const ids = [...new Set(observationIds.map((id) => normalizedUuid(id, "observationId")))];
    if (ids.length < 1 || ids.length > 50) {
      throw new TypeError("observationIds must contain 1 to 50 UUIDs");
    }
    const params = new URLSearchParams();
    for (const id of ids) params.append("id", id);
    return (
      await this.transport.json<readonly Observation[]>(`api/v1/observations?${params}`, {
        workspaceId: this.workspaceId,
        signal,
      })
    ).data;
  }

  async forgetEpisode(episodeId: string, options: MutationOptions = {}): Promise<void> {
    await this.transport.json<void>(`api/v1/episodes/${normalizedUuid(episodeId, "episodeId")}`, {
      method: "DELETE",
      workspaceId: this.workspaceId,
      headers: { "idempotency-key": normalizedIdempotencyKey(options.idempotencyKey) },
      signal: options.signal,
    });
  }

  async listMemoryProposals(
    input: MemoryProposalListInput = {},
  ): Promise<readonly MemoryProposal[]> {
    const params = new URLSearchParams({ limit: String(normalizedLimit(input.limit, 50)) });
    if (input.status) params.set("status", input.status);
    return (
      await this.transport.json<readonly MemoryProposal[]>(`api/v1/memory-proposals?${params}`, {
        workspaceId: this.workspaceId,
        signal: input.signal,
      })
    ).data;
  }

  async proposeMemory(
    input: CreateMemoryProposalInput,
    options: MutationOptions = {},
  ): Promise<MemoryProposal> {
    return (
      await this.transport.json<MemoryProposal>("api/v1/memory-proposals", {
        method: "POST",
        workspaceId: this.workspaceId,
        body: input,
        headers: { "idempotency-key": normalizedIdempotencyKey(options.idempotencyKey) },
        signal: options.signal,
      })
    ).data;
  }

  async reviewMemoryProposal(
    proposalId: string,
    decision: "accept" | "reject",
    signal?: AbortSignal,
  ): Promise<MemoryProposalReviewResult> {
    return (
      await this.transport.json<MemoryProposalReviewResult>(
        `api/v1/memory-proposals/${normalizedUuid(proposalId, "proposalId")}/review`,
        {
          method: "POST",
          workspaceId: this.workspaceId,
          body: { decision },
          signal,
        },
      )
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
  // Validate gateway secrets here so a malformed value is reported by its
  // variable name, before the client ever builds a header from it.
  const gateway =
    configuredGatewayAuth[0] === "cloudflare-access-token"
      ? ({
          type: "cloudflare-access-token",
          token: gatewayCredential(
            environment.LORE_ACCESS_TOKEN ?? "",
            ACCESS_TOKEN_MAXIMUM_LENGTH,
            "LORE_ACCESS_TOKEN",
          ),
        } as const)
      : configuredGatewayAuth[0] === "cloudflare-service-token"
        ? ({
            type: "cloudflare-service-token",
            clientId: gatewayCredential(
              environment.LORE_ACCESS_CLIENT_ID ?? "",
              ACCESS_SERVICE_CREDENTIAL_MAXIMUM_LENGTH,
              "LORE_ACCESS_CLIENT_ID",
            ),
            clientSecret: gatewayCredential(
              environment.LORE_ACCESS_CLIENT_SECRET ?? "",
              ACCESS_SERVICE_CREDENTIAL_MAXIMUM_LENGTH,
              "LORE_ACCESS_CLIENT_SECRET",
            ),
          } as const)
        : undefined;
  const allowInsecureValue = environment.LORE_ALLOW_INSECURE?.trim().toLowerCase();
  if (allowInsecureValue && !["0", "1", "false", "true"].includes(allowInsecureValue)) {
    throw new TypeError("LORE_ALLOW_INSECURE must be 0, 1, false, or true");
  }
  const timeoutValue = environment.LORE_REQUEST_TIMEOUT_MS?.trim();
  if (timeoutValue && !/^\d+$/.test(timeoutValue)) {
    throw new TypeError("LORE_REQUEST_TIMEOUT_MS must be an integer from 1 to 300000");
  }
  const timeoutMs = timeoutValue ? normalizedTimeoutMs(Number(timeoutValue)) : undefined;
  return {
    client: {
      baseUrl: environment.LORE_URL?.trim() || "http://127.0.0.1:3000",
      auth,
      gateway,
      allowInsecure: allowInsecureValue === "1" || allowInsecureValue === "true",
      timeoutMs,
    },
    workspaceId: environment.LORE_WORKSPACE_ID?.trim() || undefined,
  };
}
