import { type ActorContext, installActorContext } from "./actor-context";
import type { PostgresDatabase } from "./db";
import { createMemoryModule } from "./memory";

export type EvaluationRunStatus = "running" | "completed" | "failed";

export class EvaluationSuiteNotFoundError extends Error {
  override name = "EvaluationSuiteNotFoundError";
}

export interface RankingMetrics {
  recallAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  isolationPassed: boolean;
  forbiddenRetrievedIds: string[];
}

export interface EvaluationCaseInput {
  query: string;
  expectedMemoryIds: string[];
  forbiddenMemoryIds?: string[];
  limit?: number;
}

export interface EvaluationCase extends Required<EvaluationCaseInput> {
  id: string;
  ordinal: number;
}

export interface EvaluationSuite {
  id: string;
  workspaceId: string;
  createdByUserId: string;
  name: string;
  version: number;
  description: string;
  cases: EvaluationCase[];
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationResult {
  id: string;
  caseId: string;
  retrievedMemoryIds: string[];
  metrics: RankingMetrics;
  latencyMs: number;
  estimatedCostUsd: number;
}

export interface EvaluationRunMetrics {
  recallAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  isolationPassed: boolean;
  hardFailureCount: number;
  caseCount: number;
  averageLatencyMs: number;
  estimatedCostUsd: number;
}

export interface EvaluationRun {
  id: string;
  suiteId: string;
  workspaceId: string;
  status: EvaluationRunStatus;
  metrics: EvaluationRunMetrics;
  error: string | null;
  results: EvaluationResult[];
  startedAt: string;
  completedAt: string | null;
}

export interface EvaluationSearchProvider {
  search(
    actor: ActorContext,
    input: { query: string; limit: number },
  ): Promise<Array<{ memory: { id: string } }>>;
}

export interface EvaluationModuleOptions {
  searchProvider?: EvaluationSearchProvider;
  now?: () => number;
  estimateCostUsd?: (input: { query: string; retrievedCount: number }) => number;
}

interface SuiteRow {
  id: string;
  workspace_id: string;
  created_by_user_id: string;
  name: string;
  version: number;
  description: string;
  created_at: string;
  updated_at: string;
}

interface CaseRow {
  id: string;
  ordinal: number;
  query: string;
  expected_memory_ids: string[];
  forbidden_memory_ids: string[];
  result_limit: number;
}

interface RunRow {
  id: string;
  workspace_id: string;
  suite_id: string;
  status: EvaluationRunStatus;
  metrics: EvaluationRunMetrics | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

interface ResultRow {
  id: string;
  case_id: string;
  retrieved_memory_ids: string[];
  metrics: RankingMetrics;
  latency_ms: number;
  estimated_cost_usd: string | number;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function mean(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

export function evaluateRanking(input: {
  retrievedMemoryIds: string[];
  expectedMemoryIds: string[];
  forbiddenMemoryIds?: string[];
  limit: number;
}): RankingMetrics {
  const retrieved = unique(input.retrievedMemoryIds).slice(0, Math.max(0, input.limit));
  const expected = new Set(unique(input.expectedMemoryIds));
  const forbidden = new Set(unique(input.forbiddenMemoryIds ?? []));
  const relevantRanks = retrieved.flatMap((id, index) => (expected.has(id) ? [index + 1] : []));
  const idealHitCount = Math.min(expected.size, Math.max(0, input.limit));
  const dcg = relevantRanks.reduce((score, rank) => score + 1 / Math.log2(rank + 1), 0);
  const idealDcg = Array.from(
    { length: idealHitCount },
    (_, index) => 1 / Math.log2(index + 2),
  ).reduce((total, value) => total + value, 0);
  const forbiddenRetrievedIds = retrieved.filter((id) => forbidden.has(id));
  return {
    recallAtK: expected.size ? relevantRanks.length / expected.size : 0,
    reciprocalRank: relevantRanks[0] ? 1 / relevantRanks[0] : 0,
    ndcgAtK: idealDcg ? dcg / idealDcg : 0,
    isolationPassed: forbiddenRetrievedIds.length === 0,
    forbiddenRetrievedIds,
  };
}

function toCase(row: CaseRow): EvaluationCase {
  return {
    id: row.id,
    ordinal: row.ordinal,
    query: row.query,
    expectedMemoryIds: row.expected_memory_ids,
    forbiddenMemoryIds: row.forbidden_memory_ids,
    limit: row.result_limit,
  };
}

function toSuite(row: SuiteRow, cases: EvaluationCase[]): EvaluationSuite {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdByUserId: row.created_by_user_id,
    name: row.name,
    version: row.version,
    description: row.description,
    cases,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toResult(row: ResultRow): EvaluationResult {
  return {
    id: row.id,
    caseId: row.case_id,
    retrievedMemoryIds: row.retrieved_memory_ids,
    metrics: row.metrics,
    latencyMs: Number(row.latency_ms),
    estimatedCostUsd: Number(row.estimated_cost_usd),
  };
}

function toRun(row: RunRow, results: EvaluationResult[]): EvaluationRun {
  return {
    id: row.id,
    suiteId: row.suite_id,
    workspaceId: row.workspace_id,
    status: row.status,
    metrics: row.metrics ?? {
      recallAtK: 0,
      reciprocalRank: 0,
      ndcgAtK: 0,
      isolationPassed: true,
      hardFailureCount: 0,
      caseCount: 0,
      averageLatencyMs: 0,
      estimatedCostUsd: 0,
    },
    error: row.error,
    results,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function createEvaluationModule(
  database: PostgresDatabase,
  options: EvaluationModuleOptions = {},
) {
  const searchProvider = options.searchProvider ?? createMemoryModule(database);
  const now = options.now ?? (() => performance.now());
  const estimateCostUsd = options.estimateCostUsd ?? (() => 0);

  async function getSuite(actor: ActorContext, suiteId: string): Promise<EvaluationSuite | null> {
    return database.transaction(async (transaction) => {
      await installActorContext(transaction, actor);
      const suiteResult = await transaction.query<SuiteRow>(
        "SELECT * FROM evaluation_suites WHERE workspace_id = $1 AND id = $2",
        [actor.workspaceId, suiteId],
      );
      const suite = suiteResult.rows[0];
      if (!suite) return null;
      const caseResult = await transaction.query<CaseRow>(
        `SELECT id, ordinal, query, expected_memory_ids, forbidden_memory_ids, result_limit
         FROM evaluation_cases
         WHERE workspace_id = $1 AND suite_id = $2
         ORDER BY ordinal, id`,
        [actor.workspaceId, suiteId],
      );
      return toSuite(suite, caseResult.rows.map(toCase));
    });
  }

  return {
    async createSuite(
      actor: ActorContext,
      input: { name: string; version?: number; description?: string; cases: EvaluationCaseInput[] },
    ): Promise<EvaluationSuite> {
      if (!input.name.trim()) throw new Error("Evaluation suite name is required");
      if (!input.cases.length) throw new Error("Evaluation suite requires at least one case");
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const suiteId = crypto.randomUUID();
        const suiteResult = await transaction.query<SuiteRow>(
          `INSERT INTO evaluation_suites (
             id, workspace_id, created_by_user_id, name, version, description
           ) VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            suiteId,
            actor.workspaceId,
            actor.userId,
            input.name,
            Math.max(1, Math.floor(input.version ?? 1)),
            input.description ?? "",
          ],
        );
        const cases: EvaluationCase[] = [];
        for (const [ordinal, evaluationCase] of input.cases.entries()) {
          if (!evaluationCase.query.trim() || !evaluationCase.expectedMemoryIds.length) {
            throw new Error("Each Evaluation case requires a query and expected Memory");
          }
          const result = await transaction.query<CaseRow>(
            `INSERT INTO evaluation_cases (
               id, workspace_id, suite_id, ordinal, query,
               expected_memory_ids, forbidden_memory_ids, result_limit
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING
               id, ordinal, query, expected_memory_ids, forbidden_memory_ids, result_limit`,
            [
              crypto.randomUUID(),
              actor.workspaceId,
              suiteId,
              ordinal,
              evaluationCase.query,
              unique(evaluationCase.expectedMemoryIds),
              unique(evaluationCase.forbiddenMemoryIds ?? []),
              Math.max(1, Math.min(evaluationCase.limit ?? 10, 100)),
            ],
          );
          cases.push(toCase(result.rows[0]));
        }
        return toSuite(suiteResult.rows[0], cases);
      });
    },

    getSuite,

    async listSuites(actor: ActorContext): Promise<EvaluationSuite[]> {
      const suiteIds = await database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<{ id: string }>(
          `SELECT id
           FROM evaluation_suites
           WHERE workspace_id = $1
           ORDER BY updated_at DESC, id`,
          [actor.workspaceId],
        );
        return result.rows.map((row) => row.id);
      });
      const suites = await Promise.all(suiteIds.map((suiteId) => getSuite(actor, suiteId)));
      return suites.filter((suite): suite is EvaluationSuite => suite !== null);
    },

    async getRun(actor: ActorContext, runId: string): Promise<EvaluationRun | null> {
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const runResult = await transaction.query<RunRow>(
          "SELECT * FROM evaluation_runs WHERE workspace_id = $1 AND id = $2",
          [actor.workspaceId, runId],
        );
        const run = runResult.rows[0];
        if (!run) return null;
        const resultRows = await transaction.query<ResultRow>(
          `SELECT result.*
           FROM evaluation_results result
           JOIN evaluation_cases evaluation_case ON evaluation_case.id = result.case_id
           WHERE result.workspace_id = $1 AND result.run_id = $2
           ORDER BY evaluation_case.ordinal, result.id`,
          [actor.workspaceId, runId],
        );
        return toRun(run, resultRows.rows.map(toResult));
      });
    },

    async runSuite(actor: ActorContext, suiteId: string): Promise<EvaluationRun> {
      const suite = await getSuite(actor, suiteId);
      if (!suite) throw new EvaluationSuiteNotFoundError("Evaluation suite not found");
      const runId = crypto.randomUUID();
      await database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        await transaction.query(
          `INSERT INTO evaluation_runs (id, workspace_id, suite_id)
           VALUES ($1, $2, $3)`,
          [runId, actor.workspaceId, suiteId],
        );
      });

      const completedResults: EvaluationResult[] = [];
      try {
        for (const evaluationCase of suite.cases) {
          const startedAt = now();
          const searchResults = await searchProvider.search(actor, {
            query: evaluationCase.query,
            limit: evaluationCase.limit,
          });
          const latencyMs = Math.max(0, now() - startedAt);
          const retrievedMemoryIds = unique(searchResults.map((result) => result.memory.id)).slice(
            0,
            evaluationCase.limit,
          );
          const metrics = evaluateRanking({
            retrievedMemoryIds,
            expectedMemoryIds: evaluationCase.expectedMemoryIds,
            forbiddenMemoryIds: evaluationCase.forbiddenMemoryIds,
            limit: evaluationCase.limit,
          });
          const estimatedCost = Math.max(
            0,
            estimateCostUsd({
              query: evaluationCase.query,
              retrievedCount: retrievedMemoryIds.length,
            }),
          );
          const resultId = crypto.randomUUID();
          await database.transaction(async (transaction) => {
            await installActorContext(transaction, actor);
            await transaction.query(
              `INSERT INTO evaluation_results (
                 id, workspace_id, run_id, case_id, retrieved_memory_ids,
                 metrics, latency_ms, estimated_cost_usd
               ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
              [
                resultId,
                actor.workspaceId,
                runId,
                evaluationCase.id,
                retrievedMemoryIds,
                JSON.stringify(metrics),
                latencyMs,
                estimatedCost,
              ],
            );
          });
          completedResults.push({
            id: resultId,
            caseId: evaluationCase.id,
            retrievedMemoryIds,
            metrics,
            latencyMs,
            estimatedCostUsd: estimatedCost,
          });
        }

        const hardFailureCount = completedResults.filter(
          (result) => !result.metrics.isolationPassed,
        ).length;
        const metrics: EvaluationRunMetrics = {
          recallAtK: mean(completedResults.map((result) => result.metrics.recallAtK)),
          reciprocalRank: mean(completedResults.map((result) => result.metrics.reciprocalRank)),
          ndcgAtK: mean(completedResults.map((result) => result.metrics.ndcgAtK)),
          isolationPassed: hardFailureCount === 0,
          hardFailureCount,
          caseCount: completedResults.length,
          averageLatencyMs: mean(completedResults.map((result) => result.latencyMs)),
          estimatedCostUsd: completedResults.reduce(
            (total, result) => total + result.estimatedCostUsd,
            0,
          ),
        };
        const status: EvaluationRunStatus = metrics.isolationPassed ? "completed" : "failed";
        const error = metrics.isolationPassed
          ? null
          : "Isolation failure: forbidden Memory retrieved";
        await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          await transaction.query(
            `UPDATE evaluation_runs
             SET status = $3, metrics = $4::jsonb, error = $5, completed_at = now()
             WHERE workspace_id = $1 AND id = $2`,
            [actor.workspaceId, runId, status, JSON.stringify(metrics), error],
          );
        });
      } catch (error) {
        await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          await transaction.query(
            `UPDATE evaluation_runs
             SET status = 'failed', error = $3, completed_at = now()
             WHERE workspace_id = $1 AND id = $2`,
            [actor.workspaceId, runId, error instanceof Error ? error.message : String(error)],
          );
        });
        throw error;
      }

      const completedRun = await this.getRun(actor, runId);
      if (!completedRun) throw new Error("Completed Evaluation run could not be loaded");
      return completedRun;
    },
  };
}
