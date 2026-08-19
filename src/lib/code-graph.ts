import type { PostgresDatabase } from "@corespeed/lore-core";
import { type ActorContext, installActorContext } from "@corespeed/lore-core";
import type { CodeDependencyKind } from "./code-index";
import { CodeIndexValidationError } from "./code-index-errors";

export type CodeDependencyDirection = "callers" | "callees";
export type CodeDependencyResolution = "resolved" | "ambiguous" | "unresolved";

export interface QueryCodeDependenciesInput {
  repositoryKey: string;
  commitOid: string;
  direction: CodeDependencyDirection;
  symbol?: string;
  path?: string;
  limit?: number;
}

export interface CodeGraphLocator {
  artifactId: string | null;
  path: string | null;
  symbol: string | null;
  symbolKey: string | null;
}

export interface CodeDependencyEdge {
  id: string;
  kind: CodeDependencyKind;
  resolution: CodeDependencyResolution;
  targetText: string;
  from: CodeGraphLocator;
  to: CodeGraphLocator;
  site: {
    path: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
}

interface CodeDependencyResultBase {
  repositoryKey: string;
  commitOid: string;
  direction: CodeDependencyDirection;
}

export type CodeDependencyQueryResult =
  | (CodeDependencyResultBase & {
      status: "ok";
      subject: CodeGraphLocator;
      edges: CodeDependencyEdge[];
      truncated: boolean;
    })
  | (CodeDependencyResultBase & {
      status: "ambiguous";
      candidates: CodeGraphLocator[];
      truncated: boolean;
    })
  | (CodeDependencyResultBase & {
      status: "not_found";
      candidates: [];
    });

export interface CodeDependencyGraphModule {
  query(actor: ActorContext, input: QueryCodeDependenciesInput): Promise<CodeDependencyQueryResult>;
}

interface SymbolCandidateRow {
  artifact_id: string;
  path: string;
  symbol: string;
  symbol_key: string;
}

interface PathCandidateRow {
  path: string;
}

interface DependencyEdgeRow {
  id: string;
  kind: CodeDependencyKind;
  resolution: CodeDependencyResolution;
  target_text: string;
  from_artifact_id: string;
  from_path: string;
  from_symbol: string | null;
  from_symbol_key: string | null;
  to_artifact_id: string | null;
  to_path: string | null;
  to_symbol: string | null;
  to_symbol_key: string | null;
  site_start_line: number;
  site_start_column: number;
  site_end_line: number;
  site_end_column: number;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function validatePlainText(value: string, name: string, maximumLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || hasControlCharacters(normalized)) {
    throw new CodeIndexValidationError(`${name} is invalid`);
  }
  return normalized;
}

function validateCommitOid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(normalized)) {
    throw new CodeIndexValidationError("commitOid must be a full 40- or 64-character Git OID");
  }
  return normalized;
}

function validatePath(value: string): string {
  const path = value.trim();
  if (
    path !== value ||
    !path ||
    path.length > 1_024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    hasControlCharacters(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new CodeIndexValidationError("path is invalid");
  }
  return path;
}

function locator(row: SymbolCandidateRow): CodeGraphLocator {
  return {
    artifactId: row.artifact_id,
    path: row.path,
    symbol: row.symbol,
    symbolKey: row.symbol_key,
  };
}

function edge(row: DependencyEdgeRow): CodeDependencyEdge {
  return {
    id: row.id,
    kind: row.kind,
    resolution: row.resolution,
    targetText: row.target_text,
    from: {
      artifactId: row.from_artifact_id,
      path: row.from_path,
      symbol: row.from_symbol,
      symbolKey: row.from_symbol_key,
    },
    to: {
      artifactId: row.to_artifact_id,
      path: row.to_path,
      symbol: row.to_symbol ?? (row.resolution === "resolved" ? null : row.target_text),
      symbolKey: row.to_symbol_key,
    },
    site: {
      path: row.from_path,
      startLine: Number(row.site_start_line),
      startColumn: Number(row.site_start_column),
      endLine: Number(row.site_end_line),
      endColumn: Number(row.site_end_column),
    },
  };
}

export function createCodeDependencyGraphModule(
  database: PostgresDatabase,
): CodeDependencyGraphModule {
  return {
    async query(actor, input) {
      const repositoryKey = validatePlainText(input.repositoryKey, "repositoryKey", 512);
      const commitOid = validateCommitOid(input.commitOid);
      if (input.direction !== "callers" && input.direction !== "callees") {
        throw new CodeIndexValidationError("direction must be callers or callees");
      }
      const hasSymbol = input.symbol !== undefined;
      const hasPath = input.path !== undefined;
      if (hasSymbol === hasPath) {
        throw new CodeIndexValidationError("Provide exactly one of symbol or path");
      }
      const symbol = hasSymbol ? validatePlainText(input.symbol ?? "", "symbol", 1_600) : null;
      const path = hasPath ? validatePath(input.path ?? "") : null;
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new CodeIndexValidationError("limit must be an integer from 1 through 200");
      }

      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        let subject: CodeGraphLocator;
        let subjectSymbolKey: string | null = null;
        let subjectSymbolKeySuffix: string | null = null;

        if (symbol) {
          const candidates = await transaction.query<SymbolCandidateRow>(
            `WITH selected_generation AS MATERIALIZED (
               SELECT repository.id AS repository_id, revision.id AS revision_id,
                 generation.id AS generation_id
               FROM code_repositories repository
               JOIN code_revisions revision
                 ON revision.workspace_id = repository.workspace_id
                AND revision.repository_id = repository.id
               JOIN code_index_generations generation
                 ON generation.workspace_id = revision.workspace_id
                AND generation.repository_id = revision.repository_id
                AND generation.revision_id = revision.id
               WHERE repository.workspace_id = $1
                 AND repository.repository_key = $2
                 AND revision.commit_oid = $3
                 AND generation.status = 'active'
             )
             SELECT DISTINCT ON (artifact.path || '#' || indexed_symbol.symbol_key_suffix)
               artifact.id AS artifact_id, artifact.path,
               indexed_symbol.symbol,
               artifact.path || '#' || indexed_symbol.symbol_key_suffix AS symbol_key
             FROM selected_generation selected
             JOIN code_artifacts artifact
               ON artifact.workspace_id = $1
              AND artifact.repository_id = selected.repository_id
              AND artifact.revision_id = selected.revision_id
              AND artifact.generation_id = selected.generation_id
             JOIN code_symbol_payloads indexed_symbol
               ON indexed_symbol.workspace_id = artifact.workspace_id
              AND indexed_symbol.symbol_set_id = artifact.symbol_set_id
             WHERE artifact.path || '#' || indexed_symbol.symbol_key_suffix = $4
                OR indexed_symbol.symbol = $4
             ORDER BY artifact.path || '#' || indexed_symbol.symbol_key_suffix,
               (artifact.path || '#' || indexed_symbol.symbol_key_suffix = $4) DESC,
               artifact.declaration_chunk_ordinal, artifact.ordinal, artifact.id
             LIMIT $5`,
            [actor.workspaceId, repositoryKey, commitOid, symbol, limit + 1],
          );
          if (candidates.rows.length === 0) {
            return {
              status: "not_found",
              repositoryKey,
              commitOid,
              direction: input.direction,
              candidates: [],
            };
          }
          if (candidates.rows.length > 1) {
            return {
              status: "ambiguous",
              repositoryKey,
              commitOid,
              direction: input.direction,
              candidates: candidates.rows.slice(0, limit).map(locator),
              truncated: candidates.rows.length > limit,
            };
          }
          const candidate = candidates.rows[0];
          if (!candidate) throw new Error("Code Graph symbol candidate disappeared");
          subject = locator(candidate);
          subjectSymbolKey = candidate.symbol_key;
          const symbolPrefix = `${candidate.path}#`;
          if (!candidate.symbol_key.startsWith(symbolPrefix)) {
            throw new Error("Code Graph symbol key is not qualified by its Artifact path");
          }
          subjectSymbolKeySuffix = candidate.symbol_key.slice(symbolPrefix.length);
        } else {
          const candidates = await transaction.query<PathCandidateRow>(
            `SELECT artifact.path
             FROM code_repositories repository
             JOIN code_revisions revision
               ON revision.workspace_id = repository.workspace_id
              AND revision.repository_id = repository.id
             JOIN code_index_generations generation
               ON generation.workspace_id = revision.workspace_id
              AND generation.repository_id = revision.repository_id
              AND generation.revision_id = revision.id
              AND generation.status = 'active'
             JOIN code_artifacts artifact
               ON artifact.workspace_id = generation.workspace_id
              AND artifact.repository_id = generation.repository_id
              AND artifact.revision_id = generation.revision_id
              AND artifact.generation_id = generation.id
             WHERE repository.workspace_id = $1
               AND repository.repository_key = $2
               AND revision.commit_oid = $3
               AND artifact.path = $4
             ORDER BY artifact.ordinal, artifact.id
             LIMIT 1`,
            [actor.workspaceId, repositoryKey, commitOid, path],
          );
          const first = candidates.rows[0];
          if (!first) {
            return {
              status: "not_found",
              repositoryKey,
              commitOid,
              direction: input.direction,
              candidates: [],
            };
          }
          subject = { artifactId: null, path: first.path, symbol: null, symbolKey: null };
        }

        const edgeParams: unknown[] = [actor.workspaceId, repositoryKey, commitOid];
        let directionPredicate: string;
        if (input.direction === "callees" && symbol !== null) {
          edgeParams.push(subject.path, subjectSymbolKeySuffix);
          directionPredicate = `from_artifact.path = $${edgeParams.length - 1}
            AND dependency_payload.from_symbol_key_suffix = $${edgeParams.length}`;
        } else if (input.direction === "callees") {
          edgeParams.push(path);
          directionPredicate = `from_artifact.path = $${edgeParams.length}`;
        } else if (symbol !== null) {
          edgeParams.push(subjectSymbolKey);
          directionPredicate = `dependency.to_symbol_key = $${edgeParams.length}`;
        } else {
          edgeParams.push(path);
          directionPredicate = `to_artifact.path = $${edgeParams.length}`;
        }
        edgeParams.push(limit + 1);
        const limitParameter = `$${edgeParams.length}`;
        const result = await transaction.query<DependencyEdgeRow>(
          `SELECT dependency.id, dependency_payload.kind, dependency.resolution,
             dependency_payload.target_text, dependency.from_artifact_id,
             from_artifact.path AS from_path,
             from_symbol.symbol AS from_symbol,
             CASE WHEN dependency_payload.from_symbol_key_suffix IS NULL THEN NULL
               ELSE from_artifact.path || '#' || dependency_payload.from_symbol_key_suffix
             END AS from_symbol_key,
             dependency.to_artifact_id, to_artifact.path AS to_path,
             to_symbol.symbol AS to_symbol,
             dependency.to_symbol_key,
             dependency_payload.site_start_line, dependency_payload.site_start_column,
             dependency_payload.site_end_line, dependency_payload.site_end_column
           FROM code_repositories repository
           JOIN code_revisions revision
             ON revision.workspace_id = repository.workspace_id
            AND revision.repository_id = repository.id
           JOIN code_index_generations generation
             ON generation.workspace_id = revision.workspace_id
            AND generation.repository_id = revision.repository_id
            AND generation.revision_id = revision.id
            AND generation.status = 'active'
           JOIN code_dependency_edges dependency
             ON dependency.workspace_id = generation.workspace_id
            AND dependency.repository_id = generation.repository_id
            AND dependency.revision_id = generation.revision_id
            AND dependency.generation_id = generation.id
           JOIN code_artifacts from_artifact
             ON from_artifact.workspace_id = dependency.workspace_id
            AND from_artifact.repository_id = dependency.repository_id
            AND from_artifact.revision_id = dependency.revision_id
            AND from_artifact.generation_id = dependency.generation_id
            AND from_artifact.id = dependency.from_artifact_id
           JOIN code_dependency_payloads dependency_payload
             ON dependency_payload.workspace_id = dependency.workspace_id
            AND dependency_payload.dependency_set_id = from_artifact.dependency_set_id
            AND dependency_payload.ordinal = dependency.dependency_ordinal
           LEFT JOIN code_symbol_payloads from_symbol
             ON from_symbol.workspace_id = dependency.workspace_id
            AND from_symbol.symbol_set_id = from_artifact.symbol_set_id
            AND from_symbol.symbol_key_suffix = dependency_payload.from_symbol_key_suffix
           LEFT JOIN code_artifacts to_artifact
             ON to_artifact.workspace_id = dependency.workspace_id
            AND to_artifact.repository_id = dependency.repository_id
            AND to_artifact.revision_id = dependency.revision_id
            AND to_artifact.generation_id = dependency.generation_id
            AND to_artifact.id = dependency.to_artifact_id
           LEFT JOIN code_symbol_payloads to_symbol
             ON to_symbol.workspace_id = dependency.workspace_id
            AND to_symbol.symbol_set_id = to_artifact.symbol_set_id
            AND to_artifact.path || '#' || to_symbol.symbol_key_suffix
              = dependency.to_symbol_key
           WHERE repository.workspace_id = $1
             AND repository.repository_key = $2
             AND revision.commit_oid = $3
             AND ${directionPredicate}
           ORDER BY from_artifact.path, dependency_payload.site_start_line,
             dependency_payload.site_start_column, dependency_payload.kind,
             dependency_payload.target_text, dependency.id
           LIMIT ${limitParameter}`,
          edgeParams,
        );
        return {
          status: "ok",
          repositoryKey,
          commitOid,
          direction: input.direction,
          subject,
          edges: result.rows.slice(0, limit).map(edge),
          truncated: result.rows.length > limit,
        };
      });
    },
  };
}
