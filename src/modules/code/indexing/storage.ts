import { posix } from "node:path";
import type { ActorContext, PostgresDatabase, PostgresTransaction } from "@corespeed/lore-core";
import { installActorContext } from "@corespeed/lore-core";
import { CodeIndexValidationError, CodeRevisionConflictError } from "./errors";
import { CODE_INDEX_REVISION } from "./protocol";
import type {
  CodeDependencyKind,
  CodeIndexJob,
  CodeIndexJobStatus,
  GitRevisionManifest,
  GitRevisionManifestEntry,
  PreparedArtifact,
  PreparedDependencyEdge,
  PreparedFileIndex,
  PreparedModuleBinding,
  ReusableArtifactRow,
} from "./types";
import { sha256 } from "./validation";

export interface RepositoryRow {
  id: string;
}

export interface RevisionRow {
  id: string;
  source_digest: string;
  tree_oid: string | null;
  tree_digest: string | null;
  file_count: number;
}

export interface GenerationRow {
  id: string;
  artifact_count: number;
  status: "active" | "building" | "failed" | "ready" | "retiring";
}

export interface ActiveGitRevisionRow extends RevisionRow {
  repository_id: string;
  generation_id: string;
  artifact_count: number;
}

export interface CodeIndexJobRow {
  id: string;
  repository_id: string;
  repository_key: string;
  commit_oid: string;
  source_ref: string | null;
  indexer_revision: string;
  status: CodeIndexJobStatus;
  attempt_count: number;
  max_attempts: number;
  available_at: Date | string;
  completed_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function remapArtifactIdentity(
  value: string | null,
  sourcePath: string,
  targetPath: string,
): string | null {
  if (value === null) return null;
  const sourcePrefix = `${sourcePath}#`;
  if (!value.startsWith(sourcePrefix)) {
    throw new CodeIndexValidationError(
      "Cached Code Artifact identity disagrees with its source path",
    );
  }
  return `${targetPath}#${value.slice(sourcePrefix.length)}`;
}

function pathFreeArtifactIdentity(value: string, path: string): string {
  const prefix = `${path}#`;
  if (!value.startsWith(prefix)) {
    throw new CodeIndexValidationError(
      "Code Artifact identity disagrees with its repository-relative path",
    );
  }
  return value.slice(prefix.length);
}

function reusableArtifact(row: ReusableArtifactRow): PreparedArtifact {
  return {
    path: row.target_path,
    language: row.language,
    parser: row.parser,
    parseStatus: row.parse_status,
    kind: row.kind,
    symbol: row.symbol,
    symbolKey: remapArtifactIdentity(row.symbol_key, row.source_path, row.target_path),
    declarationKey: remapArtifactIdentity(row.declaration_key, row.source_path, row.target_path),
    declarationChunkOrdinal: row.declaration_chunk_ordinal,
    symbols: (row.symbols ?? []).map((symbol) => ({
      symbol: symbol.symbol,
      symbolKey:
        remapArtifactIdentity(symbol.symbolKey, row.source_path, row.target_path) ??
        symbol.symbolKey,
      declarationKey:
        remapArtifactIdentity(symbol.declarationKey, row.source_path, row.target_path) ??
        symbol.declarationKey,
    })),
    ordinal: row.ordinal,
    startIndex: 0,
    endIndex: row.content.length,
    startLine: row.start_line,
    endLine: row.end_line,
    content: row.content,
    contentSha256: row.content_sha256,
  };
}

export async function loadReusableGitFiles(
  database: PostgresDatabase,
  actor: ActorContext,
  manifest: GitRevisionManifest,
  installContext: (transaction: PostgresTransaction) => Promise<void> = (transaction) =>
    installActorContext(transaction, actor),
): Promise<Map<string, PreparedFileIndex>> {
  const requestedFiles = manifest.entries
    .filter(
      (entry): entry is GitRevisionManifestEntry & { contentSha256: string } =>
        entry.status === "indexed" && entry.contentSha256 !== null,
    )
    .map((entry) => ({
      path: entry.path,
      object_oid: entry.objectOid,
      content_sha256: entry.contentSha256,
    }));
  if (requestedFiles.length === 0) return new Map();

  return database.transaction(async (transaction) => {
    await installContext(transaction);
    const result = await transaction.query<ReusableArtifactRow>(
      `WITH requested AS MATERIALIZED (
         SELECT requested_file.path, requested_file.object_oid,
           requested_file.content_sha256
         FROM jsonb_to_recordset($2::jsonb) AS requested_file(
           path text, object_oid text, content_sha256 text
         )
       ), reusable_file AS MATERIALIZED (
         SELECT DISTINCT ON (requested.path)
           requested.path AS target_path,
           previous_file.path AS source_path,
           previous_file.revision_id,
           generation.id AS generation_id
         FROM requested
         JOIN code_revision_files previous_file
           ON previous_file.workspace_id = $1
          AND previous_file.object_oid = requested.object_oid
          AND previous_file.content_sha256 = requested.content_sha256
          AND previous_file.index_status = 'indexed'
         JOIN code_revisions revision
           ON revision.workspace_id = previous_file.workspace_id
          AND revision.repository_id = previous_file.repository_id
          AND revision.id = previous_file.revision_id
         JOIN code_index_generations generation
           ON generation.workspace_id = revision.workspace_id
          AND generation.repository_id = revision.repository_id
          AND generation.revision_id = revision.id
          AND generation.indexer_revision = $3
          AND generation.status IN ('building', 'ready', 'active', 'retiring')
         ORDER BY requested.path, revision.created_at DESC, revision.id, previous_file.path
       )
       SELECT reusable_file.target_path, reusable_file.source_path,
         artifact.language, artifact.parser, artifact.parse_status, artifact.kind,
         artifact.symbol, artifact.symbol_key, artifact.declaration_key,
         artifact.declaration_chunk_ordinal,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_build_object(
               'symbol', indexed_symbol.symbol,
               'symbolKey', artifact.path || '#' || indexed_symbol.symbol_key_suffix,
               'declarationKey', artifact.path || '#' || indexed_symbol.declaration_key_suffix
             ) ORDER BY indexed_symbol.ordinal
           )
           FROM code_symbol_payloads indexed_symbol
           WHERE indexed_symbol.workspace_id = artifact.workspace_id
             AND indexed_symbol.symbol_set_id = artifact.symbol_set_id
         ), '[]'::jsonb) AS symbols,
         artifact.ordinal, artifact.start_line, artifact.end_line,
         payload.content, artifact.content_sha256,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_build_object(
               'fromSymbolKey', CASE WHEN dependency_payload.from_symbol_key_suffix IS NULL
                 THEN NULL ELSE artifact.path || '#' || dependency_payload.from_symbol_key_suffix END,
               'kind', dependency_payload.kind,
               'targetText', dependency_payload.target_text,
               'moduleBindings', dependency_payload.module_bindings,
               'siteStartLine', dependency_payload.site_start_line,
               'siteStartColumn', dependency_payload.site_start_column,
               'siteEndLine', dependency_payload.site_end_line,
               'siteEndColumn', dependency_payload.site_end_column
             ) ORDER BY dependency.dependency_ordinal
           )
           FROM code_dependency_edges dependency
           JOIN code_dependency_payloads dependency_payload
             ON dependency_payload.workspace_id = dependency.workspace_id
            AND dependency_payload.dependency_set_id = artifact.dependency_set_id
            AND dependency_payload.ordinal = dependency.dependency_ordinal
           WHERE dependency.workspace_id = artifact.workspace_id
             AND dependency.repository_id = artifact.repository_id
             AND dependency.revision_id = artifact.revision_id
             AND dependency.generation_id = artifact.generation_id
             AND dependency.from_artifact_id = artifact.id
         ), '[]'::jsonb) AS dependencies
       FROM reusable_file
       JOIN code_artifacts artifact
         ON artifact.workspace_id = $1
        AND artifact.revision_id = reusable_file.revision_id
        AND artifact.generation_id = reusable_file.generation_id
        AND artifact.path = reusable_file.source_path
       JOIN code_artifact_payloads payload
         ON payload.workspace_id = artifact.workspace_id
        AND payload.id = artifact.payload_id
        AND payload.content_sha256 = artifact.content_sha256
       ORDER BY reusable_file.target_path, artifact.ordinal`,
      [actor.workspaceId, JSON.stringify(requestedFiles), CODE_INDEX_REVISION],
    );
    const reusableByPath = new Map<string, PreparedFileIndex>();
    for (const row of result.rows) {
      const prepared = reusableByPath.get(row.target_path) ?? {
        artifacts: [],
        dependencies: [],
      };
      const artifact = reusableArtifact(row);
      prepared.artifacts.push(artifact);
      prepared.dependencies.push(
        ...(row.dependencies ?? []).map((dependency) => ({
          path: row.target_path,
          fromArtifactOrdinal: row.ordinal,
          fromSymbolKey: remapArtifactIdentity(
            dependency.fromSymbolKey,
            row.source_path,
            row.target_path,
          ),
          kind: dependency.kind,
          targetText: dependency.targetText,
          moduleBindings: dependency.moduleBindings ?? [],
          siteStartLine: dependency.siteStartLine,
          siteStartColumn: dependency.siteStartColumn,
          siteEndLine: dependency.siteEndLine,
          siteEndColumn: dependency.siteEndColumn,
        })),
      );
      reusableByPath.set(row.target_path, prepared);
    }
    const expectedHashByPath = new Map(
      requestedFiles.map((file) => [file.path, file.content_sha256] as const),
    );
    for (const [path, prepared] of reusableByPath) {
      let cursor = 0;
      for (const artifact of prepared.artifacts) {
        artifact.startIndex = cursor;
        cursor += artifact.content.length;
        artifact.endIndex = cursor;
      }
      const reconstructsBlob =
        prepared.artifacts.every(
          (artifact, ordinal) =>
            artifact.ordinal === ordinal && artifact.contentSha256 === sha256(artifact.content),
        ) &&
        sha256(prepared.artifacts.map((artifact) => artifact.content).join("")) ===
          expectedHashByPath.get(path);
      if (!reconstructsBlob) reusableByPath.delete(path);
    }
    return reusableByPath;
  });
}

interface ArtifactPayloadRow {
  id: string;
  content_sha256: string;
}

interface SymbolSetRow {
  id: string;
  derivation_sha256: string;
}

interface PathFreeSymbol {
  symbol: string;
  symbolKeySuffix: string;
  declarationKeySuffix: string;
}

function pathFreeSymbols(artifact: PreparedArtifact): PathFreeSymbol[] {
  return artifact.symbols.map((symbol) => ({
    symbol: symbol.symbol,
    symbolKeySuffix: pathFreeArtifactIdentity(symbol.symbolKey, artifact.path),
    declarationKeySuffix: pathFreeArtifactIdentity(symbol.declarationKey, artifact.path),
  }));
}

function symbolSetDigest(symbols: readonly PathFreeSymbol[]): string | null {
  return symbols.length === 0 ? null : sha256(JSON.stringify(symbols));
}

async function ensureSymbolSets(
  transaction: PostgresTransaction,
  workspaceId: string,
  artifacts: readonly PreparedArtifact[],
): Promise<Map<string, string>> {
  const symbolsByDigest = new Map<string, PathFreeSymbol[]>();
  for (const artifact of artifacts) {
    const symbols = pathFreeSymbols(artifact);
    const digest = symbolSetDigest(symbols);
    if (!digest) continue;
    const serialized = JSON.stringify(symbols);
    const existing = symbolsByDigest.get(digest);
    if (existing && JSON.stringify(existing) !== serialized) {
      throw new CodeRevisionConflictError(
        "Two Code Symbol Sets claimed the same SHA-256 digest with different derivations",
      );
    }
    symbolsByDigest.set(digest, symbols);
  }
  if (symbolsByDigest.size === 0) return new Map();

  const digests = [...symbolsByDigest.keys()];
  const symbolSetIds = new Map<string, string>();
  const existing = await transaction.query<SymbolSetRow>(
    `SELECT id, derivation_sha256
     FROM code_symbol_sets
     WHERE workspace_id = $1 AND indexer_revision = $2
       AND derivation_sha256 = ANY($3::text[])`,
    [workspaceId, CODE_INDEX_REVISION, digests],
  );
  for (const row of existing.rows) symbolSetIds.set(row.derivation_sha256, row.id);

  const missing = digests
    .filter((digest) => !symbolSetIds.has(digest))
    .map((digest) => ({ id: crypto.randomUUID(), derivation_sha256: digest }));
  if (missing.length > 0) {
    const inserted = await transaction.query<SymbolSetRow>(
      `INSERT INTO code_symbol_sets (id, workspace_id, indexer_revision, derivation_sha256)
       SELECT input.id, $1, $2, input.derivation_sha256
       FROM jsonb_to_recordset($3::jsonb) AS input(id uuid, derivation_sha256 text)
       ON CONFLICT (workspace_id, indexer_revision, derivation_sha256) DO NOTHING
       RETURNING id, derivation_sha256`,
      [workspaceId, CODE_INDEX_REVISION, JSON.stringify(missing)],
    );
    for (const row of inserted.rows) symbolSetIds.set(row.derivation_sha256, row.id);

    const symbolRows = inserted.rows.flatMap((row) =>
      (symbolsByDigest.get(row.derivation_sha256) ?? []).map((symbol, ordinal) => ({
        workspace_id: workspaceId,
        symbol_set_id: row.id,
        ordinal,
        symbol: symbol.symbol,
        symbol_key_suffix: symbol.symbolKeySuffix,
        declaration_key_suffix: symbol.declarationKeySuffix,
      })),
    );
    if (symbolRows.length > 0) {
      await transaction.query(
        `INSERT INTO code_symbol_payloads (
           workspace_id, symbol_set_id, ordinal, symbol,
           symbol_key_suffix, declaration_key_suffix
         )
         SELECT input.workspace_id, input.symbol_set_id, input.ordinal, input.symbol,
           input.symbol_key_suffix, input.declaration_key_suffix
         FROM jsonb_to_recordset($1::jsonb) AS input(
           workspace_id uuid, symbol_set_id uuid, ordinal integer, symbol text,
           symbol_key_suffix text, declaration_key_suffix text
         )
         ON CONFLICT (symbol_set_id, ordinal) DO NOTHING`,
        [JSON.stringify(symbolRows)],
      );
    }
    if (inserted.rows.length !== missing.length) {
      const concurrent = await transaction.query<SymbolSetRow>(
        `SELECT id, derivation_sha256
         FROM code_symbol_sets
         WHERE workspace_id = $1 AND indexer_revision = $2
           AND derivation_sha256 = ANY($3::text[])`,
        [workspaceId, CODE_INDEX_REVISION, missing.map((row) => row.derivation_sha256)],
      );
      for (const row of concurrent.rows) symbolSetIds.set(row.derivation_sha256, row.id);
    }
  }
  if (symbolSetIds.size !== symbolsByDigest.size) {
    throw new Error("Every Code Symbol Set must be persisted before its Artifact membership");
  }
  return symbolSetIds;
}

async function ensureArtifactPayloads(
  transaction: PostgresTransaction,
  workspaceId: string,
  artifacts: readonly PreparedArtifact[],
): Promise<Map<string, string>> {
  const contentByDigest = new Map<string, string>();
  for (const artifact of artifacts) {
    const existing = contentByDigest.get(artifact.contentSha256);
    if (existing !== undefined && existing !== artifact.content) {
      throw new CodeRevisionConflictError(
        "Two Code Artifact payloads claimed the same SHA-256 digest with different content",
      );
    }
    contentByDigest.set(artifact.contentSha256, artifact.content);
  }
  const payloads = [...contentByDigest].map(([contentSha256, content]) => ({
    id: crypto.randomUUID(),
    content_sha256: contentSha256,
    content,
  }));
  if (payloads.length === 0) return new Map();

  const payloadIds = new Map<string, string>();
  const existing = await transaction.query<ArtifactPayloadRow>(
    `SELECT id, content_sha256
     FROM code_artifact_payloads
     WHERE workspace_id = $1 AND indexer_revision = $2
       AND content_sha256 = ANY($3::text[])`,
    [workspaceId, CODE_INDEX_REVISION, payloads.map((payload) => payload.content_sha256)],
  );
  for (const payload of existing.rows) {
    payloadIds.set(payload.content_sha256, payload.id);
  }
  const missing = payloads.filter((payload) => !payloadIds.has(payload.content_sha256));
  if (missing.length > 0) {
    const inserted = await transaction.query<ArtifactPayloadRow>(
      `INSERT INTO code_artifact_payloads (
         id, workspace_id, indexer_revision, content_sha256, content
       )
       SELECT input.id, $1, $2, input.content_sha256, input.content
       FROM jsonb_to_recordset($3::jsonb) AS input(
         id uuid, content_sha256 text, content text
       )
       ON CONFLICT (workspace_id, indexer_revision, content_sha256) DO NOTHING
       RETURNING id, content_sha256`,
      [workspaceId, CODE_INDEX_REVISION, JSON.stringify(missing)],
    );
    for (const payload of inserted.rows) {
      payloadIds.set(payload.content_sha256, payload.id);
    }
    if (inserted.rows.length !== missing.length) {
      const concurrentlyInserted = await transaction.query<ArtifactPayloadRow>(
        `SELECT id, content_sha256
         FROM code_artifact_payloads
         WHERE workspace_id = $1 AND indexer_revision = $2
           AND content_sha256 = ANY($3::text[])`,
        [workspaceId, CODE_INDEX_REVISION, missing.map((payload) => payload.content_sha256)],
      );
      for (const payload of concurrentlyInserted.rows) {
        payloadIds.set(payload.content_sha256, payload.id);
      }
    }
  }
  if (payloadIds.size !== contentByDigest.size) {
    throw new Error("Every Code Artifact payload must be persisted before its membership");
  }
  return payloadIds;
}

export async function insertArtifactBatch(
  transaction: PostgresTransaction,
  actor: ActorContext,
  repositoryId: string,
  revisionId: string,
  generationId: string,
  artifacts: readonly PreparedArtifact[],
  dependencies: readonly PreparedDependencyEdge[],
): Promise<void> {
  const batchSize = 100;
  const payloadIds = new Map<string, string>();
  const payloadContentByDigest = new Map<string, string>();
  const symbolSetIds = new Map<string, string>();
  const dependenciesByArtifact = groupDependenciesByArtifact(dependencies);
  const dependencySetIds = await ensureDependencySets(
    transaction,
    actor.workspaceId,
    dependenciesByArtifact,
  );
  for (let start = 0; start < artifacts.length; start += batchSize) {
    const batch = artifacts.slice(start, start + batchSize);
    for (const artifact of batch) {
      const knownContent = payloadContentByDigest.get(artifact.contentSha256);
      if (knownContent !== undefined && knownContent !== artifact.content) {
        throw new CodeRevisionConflictError(
          "Two Code Artifact payloads claimed the same SHA-256 digest with different content",
        );
      }
      payloadContentByDigest.set(artifact.contentSha256, artifact.content);
    }
    const unknownPayloads = batch.filter((artifact) => !payloadIds.has(artifact.contentSha256));
    const resolvedPayloads = await ensureArtifactPayloads(
      transaction,
      actor.workspaceId,
      unknownPayloads,
    );
    for (const [digest, payloadId] of resolvedPayloads) payloadIds.set(digest, payloadId);
    const unknownSymbolSets = batch.filter((artifact) => {
      const digest = symbolSetDigest(pathFreeSymbols(artifact));
      return digest !== null && !symbolSetIds.has(digest);
    });
    const resolvedSymbolSets = await ensureSymbolSets(
      transaction,
      actor.workspaceId,
      unknownSymbolSets,
    );
    for (const [digest, symbolSetId] of resolvedSymbolSets) {
      symbolSetIds.set(digest, symbolSetId);
    }
    const params: unknown[] = [];
    const identifiedArtifacts = batch.map((artifact) => ({
      artifact,
      artifactId: crypto.randomUUID(),
    }));
    const rows = identifiedArtifacts.map(({ artifact, artifactId }) => {
      const payloadId = payloadIds.get(artifact.contentSha256);
      if (!payloadId) throw new Error("Code Artifact payload identity was not resolved");
      const symbolDigest = symbolSetDigest(pathFreeSymbols(artifact));
      const symbolSetId = symbolDigest ? symbolSetIds.get(symbolDigest) : null;
      if (symbolDigest && !symbolSetId) {
        throw new Error("Code Symbol Set identity was not resolved");
      }
      const artifactDependencies = dependenciesByArtifact.get(
        dependencyArtifactLocator(artifact.path, artifact.ordinal),
      );
      const dependencyDigest = dependencySetDigest(artifactDependencies ?? []);
      const dependencySetId = dependencyDigest ? dependencySetIds.get(dependencyDigest) : null;
      if (dependencyDigest && !dependencySetId) {
        throw new Error("Code Dependency Set identity was not resolved");
      }
      const offset = params.length;
      params.push(
        artifactId,
        actor.workspaceId,
        repositoryId,
        revisionId,
        generationId,
        artifact.path,
        artifact.language,
        artifact.parser,
        artifact.parseStatus,
        artifact.kind,
        artifact.symbol,
        artifact.symbolKey,
        artifact.declarationKey,
        artifact.declarationChunkOrdinal,
        artifact.ordinal,
        artifact.startLine,
        artifact.endLine,
        payloadId,
        symbolSetId,
        dependencySetId,
        artifact.contentSha256,
      );
      return `(${Array.from({ length: 21 }, (_, index) => `$${offset + index + 1}`).join(", ")})`;
    });
    await transaction.query(
      `INSERT INTO code_artifacts (
         id, workspace_id, repository_id, revision_id, generation_id, path, language,
         parser, parse_status, kind, symbol, symbol_key, declaration_key,
         declaration_chunk_ordinal, ordinal,
         start_line, end_line, payload_id, symbol_set_id, dependency_set_id,
         content_sha256
       ) VALUES ${rows.join(", ")}
       ON CONFLICT (generation_id, path, ordinal) DO NOTHING`,
      params,
    );
  }
}

interface DependencyArtifactRow {
  id: string;
  path: string;
  ordinal: number;
  dependency_set_id: string | null;
  primary_symbol: string | null;
  primary_symbol_key: string | null;
  symbol: string | null;
  symbol_key: string | null;
}

function dependencyTargetVariants(
  dependency: PreparedDependencyEdge,
  fromArtifact: DependencyArtifactRow,
): string[] {
  const variants = [dependency.targetText];
  if (dependency.kind === "calls" && dependency.targetText.startsWith("this.")) {
    const parent = fromArtifact.primary_symbol?.split(".").slice(0, -1).join(".");
    if (parent) variants.push(`${parent}.${dependency.targetText.slice("this.".length)}`);
  }
  return [...new Set(variants)];
}

function relativeImportCandidatePaths(fromPath: string, targetText: string): string[] {
  if (!targetText.startsWith(".")) return [];
  const base = posix.normalize(posix.join(posix.dirname(fromPath), targetText));
  if (base === ".." || base.startsWith("../") || base.startsWith("/")) return [];
  const extension = posix.extname(base);
  const candidates = extension
    ? [
        base,
        ...(extension === ".js" ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`] : []),
      ]
    : [
        base,
        ...[".ts", ".tsx", ".js", ".jsx", ".css", ".html"].map(
          (candidateExtension) => `${base}${candidateExtension}`,
        ),
        ...[".ts", ".tsx", ".js", ".jsx"].map(
          (candidateExtension) => `${base}/index${candidateExtension}`,
        ),
      ];
  return [...new Set(candidates)];
}

function uniqueDependencyTargets(
  candidates: readonly DependencyArtifactRow[],
): DependencyArtifactRow[] {
  const bySymbolKey = new Map<string, DependencyArtifactRow>();
  for (const candidate of candidates) {
    if (candidate.symbol_key && !bySymbolKey.has(candidate.symbol_key)) {
      bySymbolKey.set(candidate.symbol_key, candidate);
    }
  }
  return [...bySymbolKey.values()];
}

interface DependencySetRow {
  id: string;
  derivation_sha256: string;
}

interface PathFreeDependencyPayload {
  fromSymbolKeySuffix: string | null;
  kind: CodeDependencyKind;
  targetText: string;
  moduleBindings: readonly PreparedModuleBinding[];
  siteStartLine: number;
  siteStartColumn: number;
  siteEndLine: number;
  siteEndColumn: number;
}

function pathFreeDependency(dependency: PreparedDependencyEdge): PathFreeDependencyPayload {
  return {
    fromSymbolKeySuffix: dependency.fromSymbolKey
      ? pathFreeArtifactIdentity(dependency.fromSymbolKey, dependency.path)
      : null,
    kind: dependency.kind,
    targetText: dependency.targetText,
    moduleBindings: dependency.moduleBindings,
    siteStartLine: dependency.siteStartLine,
    siteStartColumn: dependency.siteStartColumn,
    siteEndLine: dependency.siteEndLine,
    siteEndColumn: dependency.siteEndColumn,
  };
}

function dependencyArtifactLocator(path: string, ordinal: number): string {
  return `${path}\0${ordinal}`;
}

function groupDependenciesByArtifact(
  dependencies: readonly PreparedDependencyEdge[],
): Map<string, PreparedDependencyEdge[]> {
  const grouped = new Map<string, PreparedDependencyEdge[]>();
  for (const dependency of dependencies) {
    const locator = dependencyArtifactLocator(dependency.path, dependency.fromArtifactOrdinal);
    const members = grouped.get(locator) ?? [];
    members.push(dependency);
    grouped.set(locator, members);
  }
  return grouped;
}

function dependencySetDigest(dependencies: readonly PreparedDependencyEdge[]): string | null {
  return dependencies.length === 0
    ? null
    : sha256(JSON.stringify(dependencies.map(pathFreeDependency)));
}

async function ensureDependencySets(
  transaction: PostgresTransaction,
  workspaceId: string,
  dependenciesByArtifact: ReadonlyMap<string, readonly PreparedDependencyEdge[]>,
): Promise<Map<string, string>> {
  const payloadsByDigest = new Map<string, readonly PathFreeDependencyPayload[]>();
  for (const dependencies of dependenciesByArtifact.values()) {
    const payloads = dependencies.map(pathFreeDependency);
    const digest = sha256(JSON.stringify(payloads));
    const existing = payloadsByDigest.get(digest);
    if (existing && JSON.stringify(existing) !== JSON.stringify(payloads)) {
      throw new CodeRevisionConflictError(
        "Two Code Dependency Sets claimed the same SHA-256 digest with different derivations",
      );
    }
    payloadsByDigest.set(digest, payloads);
  }
  if (payloadsByDigest.size === 0) return new Map();

  const digests = [...payloadsByDigest.keys()];
  const dependencySetIds = new Map<string, string>();
  const existing = await transaction.query<DependencySetRow>(
    `SELECT id, derivation_sha256
     FROM code_dependency_sets
     WHERE workspace_id = $1 AND indexer_revision = $2
       AND derivation_sha256 = ANY($3::text[])`,
    [workspaceId, CODE_INDEX_REVISION, digests],
  );
  for (const row of existing.rows) dependencySetIds.set(row.derivation_sha256, row.id);

  const missing = digests
    .filter((digest) => !dependencySetIds.has(digest))
    .map((digest) => ({ id: crypto.randomUUID(), derivation_sha256: digest }));
  if (missing.length > 0) {
    const inserted = await transaction.query<DependencySetRow>(
      `INSERT INTO code_dependency_sets (
         id, workspace_id, indexer_revision, derivation_sha256
       ) SELECT input.id, $1, $2, input.derivation_sha256
       FROM jsonb_to_recordset($3::jsonb) AS input(id uuid, derivation_sha256 text)
       ON CONFLICT (workspace_id, indexer_revision, derivation_sha256) DO NOTHING
       RETURNING id, derivation_sha256`,
      [workspaceId, CODE_INDEX_REVISION, JSON.stringify(missing)],
    );
    for (const row of inserted.rows) dependencySetIds.set(row.derivation_sha256, row.id);
    const payloadRows = inserted.rows.flatMap((row) =>
      (payloadsByDigest.get(row.derivation_sha256) ?? []).map((payload, ordinal) => ({
        workspace_id: workspaceId,
        dependency_set_id: row.id,
        ordinal,
        from_symbol_key_suffix: payload.fromSymbolKeySuffix,
        kind: payload.kind,
        target_text: payload.targetText,
        module_bindings: payload.moduleBindings,
        site_start_line: payload.siteStartLine,
        site_start_column: payload.siteStartColumn,
        site_end_line: payload.siteEndLine,
        site_end_column: payload.siteEndColumn,
      })),
    );
    if (payloadRows.length > 0) {
      await transaction.query(
        `INSERT INTO code_dependency_payloads (
           workspace_id, dependency_set_id, ordinal, from_symbol_key_suffix,
           kind, target_text, module_bindings, site_start_line, site_start_column,
           site_end_line, site_end_column
         ) SELECT input.workspace_id, input.dependency_set_id, input.ordinal,
           input.from_symbol_key_suffix, input.kind::code_dependency_kind,
           input.target_text, input.module_bindings, input.site_start_line,
           input.site_start_column, input.site_end_line, input.site_end_column
         FROM jsonb_to_recordset($1::jsonb) AS input(
           workspace_id uuid, dependency_set_id uuid, ordinal integer,
           from_symbol_key_suffix text, kind text, target_text text,
           module_bindings jsonb, site_start_line integer,
           site_start_column integer, site_end_line integer, site_end_column integer
         ) ON CONFLICT (workspace_id, dependency_set_id, ordinal) DO NOTHING`,
        [JSON.stringify(payloadRows)],
      );
    }
    if (inserted.rows.length !== missing.length) {
      const concurrent = await transaction.query<DependencySetRow>(
        `SELECT id, derivation_sha256
         FROM code_dependency_sets
         WHERE workspace_id = $1 AND indexer_revision = $2
           AND derivation_sha256 = ANY($3::text[])`,
        [workspaceId, CODE_INDEX_REVISION, missing.map((row) => row.derivation_sha256)],
      );
      for (const row of concurrent.rows) {
        dependencySetIds.set(row.derivation_sha256, row.id);
      }
    }
  }
  if (dependencySetIds.size !== payloadsByDigest.size) {
    throw new Error("Every Code Dependency Set must be persisted before its membership");
  }
  return dependencySetIds;
}

export async function insertDependencyEdges(
  transaction: PostgresTransaction,
  actor: ActorContext,
  repositoryId: string,
  revisionId: string,
  generationId: string,
  dependencies: readonly PreparedDependencyEdge[],
): Promise<void> {
  if (dependencies.length === 0) return;
  const persisted = await transaction.query<DependencyArtifactRow>(
    `SELECT artifact.id, artifact.path, artifact.ordinal, artifact.dependency_set_id,
       artifact.symbol AS primary_symbol, artifact.symbol_key AS primary_symbol_key,
       indexed_symbol.symbol,
       CASE WHEN indexed_symbol.symbol_key_suffix IS NULL THEN NULL
         ELSE artifact.path || '#' || indexed_symbol.symbol_key_suffix END AS symbol_key
     FROM code_artifacts artifact
     LEFT JOIN code_symbol_payloads indexed_symbol
       ON indexed_symbol.workspace_id = artifact.workspace_id
      AND indexed_symbol.symbol_set_id = artifact.symbol_set_id
     WHERE artifact.workspace_id = $1 AND artifact.repository_id = $2
       AND artifact.revision_id = $3 AND artifact.generation_id = $4
     ORDER BY artifact.path, artifact.ordinal, indexed_symbol.ordinal`,
    [actor.workspaceId, repositoryId, revisionId, generationId],
  );
  const artifactByLocator = new Map<string, DependencyArtifactRow>();
  const firstArtifactByPath = new Map<string, DependencyArtifactRow>();
  const symbolsByName = new Map<string, DependencyArtifactRow[]>();
  for (const row of persisted.rows) {
    artifactByLocator.set(dependencyArtifactLocator(row.path, row.ordinal), row);
    if (!firstArtifactByPath.has(row.path)) firstArtifactByPath.set(row.path, row);
    if (row.symbol) {
      const matches = symbolsByName.get(row.symbol) ?? [];
      matches.push(row);
      symbolsByName.set(row.symbol, matches);
    }
  }
  const importedPathsBySourcePath = new Map<string, Set<string>>();
  const moduleBindingsBySourcePath = new Map<
    string,
    Array<{ binding: PreparedModuleBinding; targetPaths: readonly string[] }>
  >();
  for (const dependency of dependencies) {
    if (dependency.kind !== "imports") continue;
    const importedPaths = importedPathsBySourcePath.get(dependency.path) ?? new Set<string>();
    const targetPaths = relativeImportCandidatePaths(dependency.path, dependency.targetText).filter(
      (candidatePath) => firstArtifactByPath.has(candidatePath),
    );
    for (const candidatePath of targetPaths) {
      if (firstArtifactByPath.has(candidatePath)) importedPaths.add(candidatePath);
    }
    importedPathsBySourcePath.set(dependency.path, importedPaths);
    const bindings = moduleBindingsBySourcePath.get(dependency.path) ?? [];
    bindings.push(...dependency.moduleBindings.map((binding) => ({ binding, targetPaths })));
    moduleBindingsBySourcePath.set(dependency.path, bindings);
  }

  const resolveExport = (
    path: string,
    exportedName: string,
    visited: ReadonlySet<string> = new Set(),
  ): DependencyArtifactRow[] => {
    const visitKey = `${path}\0${exportedName}`;
    if (visited.has(visitKey) || visited.size >= 32) return [];
    const nextVisited = new Set(visited);
    nextVisited.add(visitKey);
    const direct = (symbolsByName.get(exportedName) ?? []).filter(
      (candidate) => candidate.path === path,
    );
    const forwarded = (moduleBindingsBySourcePath.get(path) ?? []).flatMap(
      ({ binding, targetPaths }) => {
        if (
          binding.kind === "reexport_named" &&
          binding.exportedName === exportedName &&
          binding.importedName
        ) {
          return targetPaths.flatMap((targetPath) =>
            resolveExport(targetPath, binding.importedName as string, nextVisited),
          );
        }
        if (binding.kind === "reexport_all" && exportedName !== "default") {
          return targetPaths.flatMap((targetPath) =>
            resolveExport(targetPath, exportedName, nextVisited),
          );
        }
        return [];
      },
    );
    return uniqueDependencyTargets([...direct, ...forwarded]);
  };

  const resolveBoundDependency = (
    dependency: PreparedDependencyEdge,
  ): { matched: boolean; candidates: DependencyArtifactRow[] } => {
    let matched = false;
    const candidates: DependencyArtifactRow[] = [];
    for (const { binding, targetPaths } of moduleBindingsBySourcePath.get(dependency.path) ?? []) {
      if (
        (binding.kind === "named" || binding.kind === "default") &&
        binding.localName === dependency.targetText
      ) {
        matched = true;
        const importedName = binding.importedName;
        if (importedName) {
          candidates.push(
            ...targetPaths.flatMap((targetPath) => resolveExport(targetPath, importedName)),
          );
        }
        if (binding.kind === "default" && candidates.length === 0) {
          candidates.push(
            ...targetPaths.flatMap((targetPath) =>
              resolveExport(targetPath, dependency.targetText),
            ),
          );
        }
      } else if (
        binding.kind === "namespace" &&
        binding.localName &&
        dependency.targetText.startsWith(`${binding.localName}.`)
      ) {
        matched = true;
        const importedName = dependency.targetText.slice(binding.localName.length + 1);
        if (importedName) {
          candidates.push(
            ...targetPaths.flatMap((targetPath) => resolveExport(targetPath, importedName)),
          );
        }
      }
    }
    return { matched, candidates: uniqueDependencyTargets(candidates) };
  };

  const dependencyOrdinal = new Map<PreparedDependencyEdge, number>();
  for (const members of groupDependenciesByArtifact(dependencies).values()) {
    members.forEach((dependency, ordinal) => {
      dependencyOrdinal.set(dependency, ordinal);
    });
  }
  const rows = dependencies.map((dependency) => {
    const fromArtifact = artifactByLocator.get(
      dependencyArtifactLocator(dependency.path, dependency.fromArtifactOrdinal),
    );
    if (!fromArtifact) {
      throw new Error("Dependency site could not be resolved to its persisted Code Artifact");
    }
    if (!fromArtifact.dependency_set_id) {
      throw new Error("Dependency site has no persisted Code Dependency Set");
    }
    const ordinal = dependencyOrdinal.get(dependency);
    if (ordinal === undefined) {
      throw new Error("Dependency ordinal could not be resolved inside its shared set");
    }
    const bound = resolveBoundDependency(dependency);
    const candidates =
      dependency.kind === "imports"
        ? relativeImportCandidatePaths(dependency.path, dependency.targetText)
            .map((candidatePath) => firstArtifactByPath.get(candidatePath))
            .filter((candidate): candidate is DependencyArtifactRow => Boolean(candidate))
        : bound.matched
          ? bound.candidates
          : uniqueDependencyTargets(
              dependencyTargetVariants(dependency, fromArtifact)
                .flatMap((variant) => symbolsByName.get(variant) ?? [])
                .filter(
                  (candidate) =>
                    candidate.path === dependency.path ||
                    importedPathsBySourcePath.get(dependency.path)?.has(candidate.path),
                ),
            );
    const target = candidates.length === 1 ? candidates[0] : null;
    return {
      dependency,
      fromArtifact,
      resolution:
        candidates.length === 1 ? "resolved" : candidates.length > 1 ? "ambiguous" : "unresolved",
      target,
      ordinal,
    } as const;
  });

  const batchSize = 100;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const params: unknown[] = [];
    const values = batch.map(({ dependency, fromArtifact, resolution, target, ordinal }) => {
      const offset = params.length;
      params.push(
        crypto.randomUUID(),
        actor.workspaceId,
        repositoryId,
        revisionId,
        generationId,
        fromArtifact.id,
        ordinal,
        resolution,
        target?.id ?? null,
        dependency.kind === "imports" ? null : (target?.symbol_key ?? null),
      );
      return `(${Array.from({ length: 10 }, (_, index) => `$${offset + index + 1}`).join(", ")})`;
    });
    await transaction.query(
      `INSERT INTO code_dependency_edges (
         id, workspace_id, repository_id, revision_id, generation_id,
         from_artifact_id, dependency_ordinal, resolution,
         to_artifact_id, to_symbol_key
       ) VALUES ${values.join(", ")}
       ON CONFLICT (
         generation_id, from_artifact_id, dependency_ordinal
       ) DO NOTHING`,
      params,
    );
  }
}

export async function insertGitManifest(
  transaction: PostgresTransaction,
  actor: ActorContext,
  repositoryId: string,
  revisionId: string,
  manifest: GitRevisionManifest,
): Promise<void> {
  const batchSize = 200;
  for (let start = 0; start < manifest.entries.length; start += batchSize) {
    const batch = manifest.entries.slice(start, start + batchSize);
    const params: unknown[] = [];
    const rows = batch.map((entry) => {
      const offset = params.length;
      params.push(
        actor.workspaceId,
        repositoryId,
        revisionId,
        entry.path,
        entry.mode,
        entry.objectType,
        entry.objectOid,
        entry.byteSize,
        entry.contentSha256,
        entry.status,
        entry.exclusionReason,
      );
      return `(${Array.from({ length: 11 }, (_, index) => `$${offset + index + 1}`).join(", ")})`;
    });
    await transaction.query(
      `INSERT INTO code_revision_files (
         workspace_id, repository_id, revision_id, path, git_mode, object_type,
         object_oid, byte_size, content_sha256, index_status, exclusion_reason
       ) VALUES ${rows.join(", ")}`,
      params,
    );
  }
}

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

export function toCodeIndexJob(row: CodeIndexJobRow): CodeIndexJob {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    repositoryKey: row.repository_key,
    commitOid: row.commit_oid,
    sourceRef: row.source_ref,
    indexerRevision: row.indexer_revision,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maximumAttempts: Number(row.max_attempts),
    availableAt: timestamp(row.available_at),
    completedAt: row.completed_at ? timestamp(row.completed_at) : null,
    lastError: row.last_error,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}
