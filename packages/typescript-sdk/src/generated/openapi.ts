// Generated from Lore's canonical OpenAPI document. Do not edit by hand.
export interface paths {
    readonly "/api/v1/actor": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["getCurrentHumanActor"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/agent-credentials/{credentialId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post?: never;
        readonly delete: operations["revokeAgentCredential"];
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/agents": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["listAgents"];
        readonly put?: never;
        readonly post: operations["createAgent"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/agents/{agentId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post?: never;
        readonly delete: operations["deleteAgent"];
        readonly options?: never;
        readonly head?: never;
        readonly patch: operations["updateAgent"];
        readonly trace?: never;
    };
    readonly "/api/v1/agents/{agentId}/credentials": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["listAgentCredentials"];
        readonly put?: never;
        readonly post: operations["issueAgentCredential"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/agents/{agentId}/grant": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put: operations["setAgentGrant"];
        readonly post?: never;
        readonly delete: operations["revokeAgentGrant"];
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/capabilities": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["getCapabilities"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/evaluations/runs/{runId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["getEvaluationRun"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/evaluations/suites": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["listEvaluationSuites"];
        readonly put?: never;
        readonly post: operations["createEvaluationSuite"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/evaluations/suites/{suiteId}/runs": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["runEvaluationSuite"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/graph": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["getMemoryGraph"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/memories": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["listOrSearchMemories"];
        readonly put?: never;
        readonly post: operations["createMemory"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/memories/{memoryId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["getMemory"];
        readonly put?: never;
        readonly post?: never;
        readonly delete: operations["deleteMemory"];
        readonly options?: never;
        readonly head?: never;
        readonly patch: operations["updateMemory"];
        readonly trace?: never;
    };
    readonly "/api/v1/workspaces": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["listWorkspaces"];
        readonly put?: never;
        readonly post: operations["createWorkspace"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/workspaces/export": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["exportWorkspace"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/workspaces/import": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["importWorkspace"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/livez": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["getLiveness"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/readyz": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["getReadiness"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        readonly AgentCredential: {
            /** Format: uuid */
            readonly agentId: string;
            /** Format: date-time */
            readonly createdAt: string;
            /** Format: uuid */
            readonly id: string;
            readonly lastUsedAt: string | null;
            readonly prefix: string;
            readonly revokedAt: string | null;
        };
        readonly AgentWorkspaceGrant: {
            /** Format: uuid */
            readonly agentId: string;
            /** Format: date-time */
            readonly createdAt: string;
            /** @enum {string} */
            readonly permission: "read" | "write";
            /** @enum {string} */
            readonly status: "active" | "revoked";
            /** Format: date-time */
            readonly updatedAt: string;
            /** Format: uuid */
            readonly workspaceId: string;
        };
        readonly Capabilities: {
            readonly activeEmbeddingGeneration: {
                /** @constant */
                readonly dimensions: 1024;
                readonly model: string;
                readonly provider: string;
                readonly revision: string;
            } | null;
            /** @constant */
            readonly apiVersion: "v1";
            /** Format: uuid */
            readonly deploymentId: string;
            readonly features: {
                /** @constant */
                readonly cursorPagination: true;
                /** @constant */
                readonly embeddingGenerations: true;
                /** @constant */
                readonly idempotency: true;
                /** @constant */
                readonly optimisticConcurrency: true;
                /** @constant */
                readonly transactionalOutbox: true;
                /** @constant */
                readonly workspacePortability: true;
            };
            readonly limits: {
                /** @constant */
                readonly workspaceArchiveLinks: 50000;
                /** @constant */
                readonly workspaceArchiveMemories: 10000;
            };
            readonly schemaRevision: number;
        };
        readonly CreateEvaluationSuiteInput: {
            readonly cases: readonly components["schemas"]["EvaluationCaseInput"][];
            readonly description?: string;
            readonly name: string;
            /** @default 1 */
            readonly version?: number;
        };
        readonly CreateMemoryInput: {
            readonly content: string;
            readonly metadata?: {
                readonly [key: string]: unknown;
            };
            /**
             * @default shared
             * @enum {string}
             */
            readonly scope?: "shared" | "private";
        };
        readonly Error: {
            /** @enum {string} */
            readonly code: "access_denied" | "authentication_required" | "idempotency_conflict" | "internal_error" | "invalid_archive" | "invalid_request" | "not_found" | "precondition_required" | "version_conflict" | "workspace_export_limit_exceeded";
            readonly error: string;
        };
        readonly EvaluationCase: {
            readonly expectedMemoryIds: readonly string[];
            readonly forbiddenMemoryIds: readonly string[];
            /** Format: uuid */
            readonly id: string;
            readonly limit: number;
            readonly ordinal: number;
            readonly query: string;
        };
        readonly EvaluationCaseInput: {
            readonly expectedMemoryIds: readonly string[];
            readonly forbiddenMemoryIds?: readonly string[];
            readonly limit?: number;
            readonly query: string;
        };
        readonly EvaluationResult: {
            /** Format: uuid */
            readonly caseId: string;
            readonly estimatedCostUsd: number;
            /** Format: uuid */
            readonly id: string;
            readonly latencyMs: number;
            readonly metrics: components["schemas"]["RankingMetrics"];
            readonly retrievedMemoryIds: readonly string[];
        };
        readonly EvaluationRun: {
            readonly completedAt: string | null;
            readonly error: string | null;
            /** Format: uuid */
            readonly id: string;
            readonly metrics: components["schemas"]["EvaluationRunMetrics"];
            readonly results: readonly components["schemas"]["EvaluationResult"][];
            /** Format: date-time */
            readonly startedAt: string;
            /** @enum {string} */
            readonly status: "running" | "completed" | "failed";
            /** Format: uuid */
            readonly suiteId: string;
            /** Format: uuid */
            readonly workspaceId: string;
        };
        readonly EvaluationRunMetrics: {
            readonly averageLatencyMs: number;
            readonly caseCount: number;
            readonly estimatedCostUsd: number;
            readonly hardFailureCount: number;
            readonly isolationPassed: boolean;
            readonly ndcgAtK: number;
            readonly recallAtK: number;
            readonly reciprocalRank: number;
        };
        readonly EvaluationSuite: {
            readonly cases: readonly components["schemas"]["EvaluationCase"][];
            /** Format: date-time */
            readonly createdAt: string;
            /** Format: uuid */
            readonly createdByUserId: string;
            readonly description: string;
            /** Format: uuid */
            readonly id: string;
            readonly name: string;
            /** Format: date-time */
            readonly updatedAt: string;
            readonly version: number;
            /** Format: uuid */
            readonly workspaceId: string;
        };
        readonly HumanActor: {
            /** @constant */
            readonly kind: "human";
            /** Format: uuid */
            readonly userId: string;
        };
        readonly ImportWorkspaceInput: {
            readonly archive: components["schemas"]["WorkspaceArchive"];
            /**
             * @default remap
             * @enum {string}
             */
            readonly conflictPolicy?: "error" | "remap" | "skip";
            /** @default false */
            readonly dryRun?: boolean;
            readonly ownerMap: {
                readonly [key: string]: string;
            };
        };
        readonly IssuedAgentCredential: {
            /** Format: uuid */
            readonly id: string;
            readonly prefix: string;
            readonly token: string;
        };
        readonly Memory: {
            readonly content: string;
            /** Format: date-time */
            readonly createdAt: string;
            readonly createdByAgentId: string | null;
            /** Format: uuid */
            readonly id: string;
            readonly metadata: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly ownerUserId: string;
            /** @enum {string} */
            readonly scope: "shared" | "private";
            /** Format: date-time */
            readonly updatedAt: string;
            readonly version: number;
            /** Format: uuid */
            readonly workspaceId: string;
        };
        readonly MemoryGraph: {
            readonly links: readonly components["schemas"]["MemoryGraphLink"][];
            readonly nodes: readonly components["schemas"]["MemoryGraphNode"][];
        };
        readonly MemoryGraphLink: {
            readonly kind: string;
            /** Format: uuid */
            readonly source: string;
            /** Format: uuid */
            readonly target: string;
            readonly weight: number;
        };
        readonly MemoryGraphNode: {
            /** Format: uuid */
            readonly id: string;
            readonly label: string;
            readonly preview: string;
            readonly reference: string;
            /** @enum {string} */
            readonly scope: "shared" | "private";
            readonly type: string;
            /** Format: date-time */
            readonly updatedAt: string;
        };
        readonly MemorySearchResult: {
            readonly evidence: string;
            readonly memory: components["schemas"]["Memory"];
            /** @description Present only after a successful calibrated reranker call. */
            readonly rerankScore?: number;
            readonly score: number;
        };
        readonly RankingMetrics: {
            readonly forbiddenRetrievedIds: readonly string[];
            readonly isolationPassed: boolean;
            readonly ndcgAtK: number;
            readonly recallAtK: number;
            readonly reciprocalRank: number;
        };
        readonly ReadinessReport: {
            readonly components: {
                /** @enum {string} */
                readonly database: "ok" | "unavailable";
                /** @enum {string} */
                readonly embedding: "ok" | "degraded" | "disabled" | "unknown";
                /** @enum {string} */
                readonly rlsRole: "ok" | "unavailable";
                /** @enum {string} */
                readonly schema: "ok" | "incompatible" | "unavailable";
                /** @enum {string} */
                readonly vector: "ok" | "unavailable";
            };
            /** @enum {string} */
            readonly status: "ready" | "degraded" | "unready";
        };
        readonly UpdateAgentInput: {
            readonly name?: string;
            /** @enum {string} */
            readonly status?: "active" | "disabled";
        };
        readonly UpdateMemoryInput: {
            readonly content?: string;
            readonly metadata?: {
                readonly [key: string]: unknown;
            };
            /** @enum {string} */
            readonly scope?: "shared" | "private";
        };
        readonly Workspace: {
            /** Format: date-time */
            readonly createdAt: string;
            /** Format: uuid */
            readonly id: string;
            readonly name: string;
            /** Format: date-time */
            readonly updatedAt: string;
        };
        readonly WorkspaceAgent: {
            /** Format: date-time */
            readonly createdAt: string;
            /** @enum {string} */
            readonly grantStatus: "active" | "revoked";
            /** Format: uuid */
            readonly id: string;
            readonly name: string;
            /** Format: uuid */
            readonly ownerUserId: string;
            /** @enum {string} */
            readonly permission: "read" | "write";
            /** @enum {string} */
            readonly status: "active" | "disabled";
            /** Format: date-time */
            readonly updatedAt: string;
        };
        readonly WorkspaceArchive: {
            readonly links: readonly components["schemas"]["WorkspaceArchiveLink"][];
            readonly manifest: components["schemas"]["WorkspaceArchiveManifest"];
            readonly memories: readonly components["schemas"]["WorkspaceArchiveMemory"][];
        };
        readonly WorkspaceArchiveLink: {
            /** Format: date-time */
            readonly createdAt: string;
            /** Format: uuid */
            readonly id: string;
            readonly kind: string;
            readonly metadata: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly sourceMemoryId: string;
            /** Format: uuid */
            readonly targetMemoryId: string;
            /** Format: date-time */
            readonly updatedAt: string;
            readonly weight: number;
        };
        readonly WorkspaceArchiveManifest: {
            readonly checksum: string;
            /** Format: date-time */
            readonly exportedAt: string;
            /** @constant */
            readonly format: "lore-workspace-v1";
            readonly linkCount: number;
            readonly memoryCount: number;
            /** Format: uuid */
            readonly sourceDeploymentId: string;
            /** Format: uuid */
            readonly sourceWorkspaceId: string;
            /** @constant */
            readonly visibility: "actor-visible";
        };
        readonly WorkspaceArchiveMemory: {
            readonly content: string;
            /** Format: date-time */
            readonly createdAt: string;
            /** Format: uuid */
            readonly id: string;
            readonly metadata: {
                readonly [key: string]: unknown;
            };
            /** Format: uuid */
            readonly ownerUserId: string;
            /** @enum {string} */
            readonly scope: "shared" | "private";
            /** Format: date-time */
            readonly updatedAt: string;
            readonly version: number;
        };
        readonly WorkspaceImportResult: {
            readonly archiveChecksum: string;
            readonly dryRun: boolean;
            readonly importedLinks: number;
            readonly importedMemories: number;
            readonly memoryIdMap: {
                readonly [key: string]: string;
            };
            readonly replayed: boolean;
            readonly skippedMemories: number;
        };
        readonly WorkspaceSummary: {
            /** Format: date-time */
            readonly createdAt: string;
            /** Format: uuid */
            readonly id: string;
            readonly name: string;
            /** @enum {string} */
            readonly role: "owner" | "admin" | "member";
            /** Format: date-time */
            readonly updatedAt: string;
        };
    };
    responses: {
        /** @description Stable Lore error */
        readonly Error: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["Error"];
            };
        };
    };
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    readonly getCurrentHumanActor: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Verified human Actor for the active Workspace */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["HumanActor"];
                };
            };
        };
    };
    readonly revokeAgentCredential: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path: {
                readonly credentialId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Credential revoked */
            readonly 204: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly listAgents: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description User-private Agents */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": readonly components["schemas"]["WorkspaceAgent"][];
                };
            };
        };
    };
    readonly createAgent: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": {
                    readonly name: string;
                    /**
                     * @default read
                     * @enum {string}
                     */
                    readonly permission?: "read" | "write";
                };
            };
        };
        readonly responses: {
            /** @description Created Agent */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["WorkspaceAgent"];
                };
            };
        };
    };
    readonly deleteAgent: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path: {
                readonly agentId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Disabled Agent, grants, and credentials deleted */
            readonly 204: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            readonly 404: components["responses"]["Error"];
            readonly 409: components["responses"]["Error"];
        };
    };
    readonly updateAgent: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path: {
                readonly agentId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["UpdateAgentInput"];
            };
        };
        readonly responses: {
            /** @description Updated global Agent identity and status */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["WorkspaceAgent"];
                };
            };
            readonly 404: components["responses"]["Error"];
        };
    };
    readonly listAgentCredentials: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path: {
                readonly agentId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Agent credential metadata without secret hashes */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": readonly components["schemas"]["AgentCredential"][];
                };
            };
        };
    };
    readonly issueAgentCredential: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path: {
                readonly agentId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description One-time Agent credential */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["IssuedAgentCredential"];
                };
            };
        };
    };
    readonly setAgentGrant: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path: {
                readonly agentId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": {
                    /** @enum {string} */
                    readonly permission: "read" | "write";
                };
            };
        };
        readonly responses: {
            /** @description Active Agent Workspace grant */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["AgentWorkspaceGrant"];
                };
            };
        };
    };
    readonly revokeAgentGrant: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path: {
                readonly agentId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Grant revoked */
            readonly 204: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly getCapabilities: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Deployment capabilities without tenant data */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Capabilities"];
                };
            };
        };
    };
    readonly getEvaluationRun: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path: {
                readonly runId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Evaluation Run and results */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["EvaluationRun"];
                };
            };
        };
    };
    readonly listEvaluationSuites: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Workspace Evaluation Suites */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": readonly components["schemas"]["EvaluationSuite"][];
                };
            };
        };
    };
    readonly createEvaluationSuite: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["CreateEvaluationSuiteInput"];
            };
        };
        readonly responses: {
            /** @description Created Evaluation Suite */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["EvaluationSuite"];
                };
            };
        };
    };
    readonly runEvaluationSuite: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path: {
                readonly suiteId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Completed Evaluation Run */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["EvaluationRun"];
                };
            };
        };
    };
    readonly getMemoryGraph: {
        readonly parameters: {
            readonly query?: {
                readonly limit?: number;
            };
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Actor-visible graph with authorized endpoints */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["MemoryGraph"];
                };
            };
        };
    };
    readonly listOrSearchMemories: {
        readonly parameters: {
            readonly query?: {
                /** @description Opaque browse cursor; mutually exclusive with offset. */
                readonly cursor?: string;
                readonly limit?: number;
                /** @description JSON object applied as a bounded JSONB-containment filter. */
                readonly metadata?: string;
                readonly offset?: number;
                readonly q?: string;
                readonly scope?: "shared" | "private";
                /** @description Inclusive lower bound for Memory updated_at. */
                readonly updated_after?: string;
                /** @description Exclusive upper bound for Memory updated_at. */
                readonly updated_before?: string;
            };
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Actor-visible Memories, or ranked results when q is present. */
            readonly 200: {
                headers: {
                    /** @description Present on a full browse page; opaque to clients. */
                    readonly "x-lore-next-cursor"?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": readonly components["schemas"]["Memory"][] | readonly components["schemas"]["MemorySearchResult"][];
                };
            };
        };
    };
    readonly createMemory: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "Idempotency-Key"?: string;
                readonly "x-lore-workspace-id": string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["CreateMemoryInput"];
            };
        };
        readonly responses: {
            /** @description Created Memory */
            readonly 201: {
                headers: {
                    readonly ETag?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Memory"];
                };
            };
            readonly 409: components["responses"]["Error"];
        };
    };
    readonly getMemory: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path: {
                readonly memoryId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Memory with a strong ETag */
            readonly 200: {
                headers: {
                    readonly ETag?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Memory"];
                };
            };
            readonly 404: components["responses"]["Error"];
        };
    };
    readonly deleteMemory: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "Idempotency-Key"?: string;
                readonly "If-Match": string;
                readonly "x-lore-workspace-id": string;
            };
            readonly path: {
                readonly memoryId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Deleted */
            readonly 204: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            readonly 412: components["responses"]["Error"];
            readonly 428: components["responses"]["Error"];
        };
    };
    readonly updateMemory: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "Idempotency-Key"?: string;
                readonly "If-Match": string;
                readonly "x-lore-workspace-id": string;
            };
            readonly path: {
                readonly memoryId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["UpdateMemoryInput"];
            };
        };
        readonly responses: {
            /** @description Updated Memory */
            readonly 200: {
                headers: {
                    readonly ETag?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Memory"];
                };
            };
            readonly 412: components["responses"]["Error"];
            readonly 428: components["responses"]["Error"];
        };
    };
    readonly listWorkspaces: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Workspaces available to the authenticated User */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": readonly components["schemas"]["WorkspaceSummary"][];
                };
            };
        };
    };
    readonly createWorkspace: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": {
                    readonly name: string;
                };
            };
        };
        readonly responses: {
            /** @description Created Workspace */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Workspace"];
                };
            };
        };
    };
    readonly exportWorkspace: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Versioned actor-visible Workspace archive */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["WorkspaceArchive"];
                };
            };
            readonly 409: components["responses"]["Error"];
        };
    };
    readonly importWorkspace: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                readonly "x-lore-workspace-id": string;
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["ImportWorkspaceInput"];
            };
        };
        readonly responses: {
            /** @description Dry-run or completed import */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["WorkspaceImportResult"];
                };
            };
        };
    };
    readonly getLiveness: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Process is live */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        /** @constant */
                        readonly status: "live";
                    };
                };
            };
        };
    };
    readonly getReadiness: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Ready or degraded */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ReadinessReport"];
                };
            };
            /** @description Not ready */
            readonly 503: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ReadinessReport"];
                };
            };
        };
    };
}
