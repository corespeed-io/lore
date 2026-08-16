import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { extname, posix } from "node:path";
import { promisify } from "node:util";
import { Lang, parseAsync, type SgNode } from "@ast-grep/napi";
import { type ActorContext, installActorContext } from "./actor-context";
import {
  CodeIndexAccessDeniedError,
  CodeIndexValidationError,
  CodeRevisionConflictError,
} from "./code-index-errors";
import { CODE_INDEX_REVISION } from "./code-index-protocol";
import { createCodeIndexReadModule } from "./code-index-read";
import { isPostgresAccessDenied } from "./database-errors";
import type { PostgresDatabase, PostgresTransaction } from "./db";

export {
  CodeIndexAccessDeniedError,
  CodeIndexValidationError,
  CodeRevisionConflictError,
} from "./code-index-errors";

export const CODE_INDEX_LIMITS = {
  maximumArtifactCodeUnits: 6_000,
  maximumArtifacts: 100_000,
  maximumFileBytes: 2 * 1024 * 1024,
  maximumFiles: 20_000,
  maximumSourceBytes: 128 * 1024 * 1024,
  parserConcurrency: 4,
} as const;

/** Bump whenever parser, symbol identity, or structural chunking behavior changes. */
export { CODE_INDEX_REVISION } from "./code-index-protocol";

export type CodeParserKind = "text" | "tree_sitter";
export type CodeParseStatus = "fallback" | "parsed" | "recovered";

export interface CodeSourceFile {
  path: string;
  content: string;
}

export interface IndexCodeRevisionInput {
  repositoryKey: string;
  displayName: string;
  commitOid: string;
  sourceRef?: string;
  files: readonly CodeSourceFile[];
}

export interface IndexGitRevisionInput {
  repositoryKey: string;
  displayName: string;
  repositoryPath: string;
  commitOid: string;
  sourceRef?: string;
}

export interface IndexedCodeRevision {
  revisionId: string;
  generationId: string;
  repositoryId: string;
  repositoryKey: string;
  commitOid: string;
  indexerRevision: string;
  sourceDigest: string;
  fileCount: number;
  artifactCount: number;
  reused: boolean;
}

export type GitTreeEntryExclusionReason =
  | "binary"
  | "empty"
  | "invalid_utf8"
  | "oversized"
  | "submodule"
  | "symlink"
  | "unsupported";

export interface GitRevisionManifestEntry {
  path: string;
  mode: string;
  objectType: string;
  objectOid: string;
  byteSize: number | null;
  contentSha256: string | null;
  status: "excluded" | "indexed";
  exclusionReason: GitTreeEntryExclusionReason | null;
}

export interface GitRevisionManifest {
  entries: readonly GitRevisionManifestEntry[];
  totalEntryCount: number;
  indexedFileCount: number;
  excludedFileCount: number;
}

export interface IndexedGitRevision extends IndexedCodeRevision {
  manifest: GitRevisionManifest;
  parsedFileCount: number;
  reusedFileCount: number;
}

export type CodeIndexJobStatus = "cancelled" | "dead" | "pending" | "processing" | "succeeded";

export interface CodeIndexJob {
  id: string;
  repositoryId: string;
  repositoryKey: string;
  commitOid: string;
  sourceRef: string | null;
  indexerRevision: string;
  status: CodeIndexJobStatus;
  attemptCount: number;
  maximumAttempts: number;
  availableAt: string;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CodeIndexJobSelector {
  jobId: string;
}

export interface SearchCodeIndexInput {
  repositoryKey: string;
  commitOid: string;
  query: string;
  limit?: number;
  pathPrefix?: string;
}

export type CodeSearchChannel = "lexical" | "literal" | "path" | "symbol";

export interface CodeRevisionSelector {
  repositoryKey: string;
  commitOid: string;
}

export interface CodeArtifact {
  id: string;
  repositoryId: string;
  revisionId: string;
  generationId: string;
  commitOid: string;
  path: string;
  language: string;
  parser: CodeParserKind;
  parseStatus: CodeParseStatus;
  kind: string;
  symbol: string | null;
  symbolKey: string | null;
  declarationKey: string | null;
  declarationChunkOrdinal: number | null;
  symbols: readonly CodeArtifactSymbol[];
  ordinal: number;
  startLine: number;
  endLine: number;
  content: string;
  contentSha256: string;
  matchedChannels: readonly CodeSearchChannel[];
  score: number;
}

export interface CodeArtifactSymbol {
  symbol: string;
  symbolKey: string;
  declarationKey: string;
}

export interface CodeIndexModule {
  /** Durably queues one authenticated exact local-Git commit without publishing partial output. */
  enqueueGitRevision(actor: ActorContext, input: IndexGitRevisionInput): Promise<CodeIndexJob>;
  /** Returns RLS-visible status without exposing the repository's local filesystem path. */
  getIndexJob(actor: ActorContext, input: CodeIndexJobSelector): Promise<CodeIndexJob>;
  /** Stores one immutable Git snapshot and the current versioned index generation atomically. */
  indexRevision(actor: ActorContext, input: IndexCodeRevisionInput): Promise<IndexedCodeRevision>;
  /** Reads and authenticates one exact commit directly from a local Git object database. */
  indexGitRevision(actor: ActorContext, input: IndexGitRevisionInput): Promise<IndexedGitRevision>;
  /** Returns the complete persisted Git tree accounting for one authenticated revision. */
  getGitRevisionManifest(
    actor: ActorContext,
    input: CodeRevisionSelector,
  ): Promise<GitRevisionManifest>;
  /** Searches only artifacts from the requested repository and exact commit OID. */
  search(actor: ActorContext, input: SearchCodeIndexInput): Promise<CodeArtifact[]>;
}

interface PreparedArtifact {
  path: string;
  language: string;
  parser: CodeParserKind;
  parseStatus: CodeParseStatus;
  kind: string;
  symbol: string | null;
  symbolKey: string | null;
  declarationKey: string | null;
  declarationChunkOrdinal: number | null;
  symbols: readonly CodeArtifactSymbol[];
  ordinal: number;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
  content: string;
  contentSha256: string;
}

export type CodeDependencyKind = "calls" | "imports" | "references";

interface PreparedDependencyEdge {
  path: string;
  fromArtifactOrdinal: number;
  fromSymbolKey: string | null;
  kind: CodeDependencyKind;
  targetText: string;
  moduleBindings: readonly PreparedModuleBinding[];
  siteStartLine: number;
  siteStartColumn: number;
  siteEndLine: number;
  siteEndColumn: number;
}

type PreparedModuleBindingKind =
  | "default"
  | "named"
  | "namespace"
  | "reexport_all"
  | "reexport_named";

interface PreparedModuleBinding {
  kind: PreparedModuleBindingKind;
  localName?: string;
  importedName?: string;
  exportedName?: string;
}

interface PreparedFileIndex {
  artifacts: PreparedArtifact[];
  dependencies: PreparedDependencyEdge[];
}

interface ReusableArtifactRow {
  target_path: string;
  source_path: string;
  language: string;
  parser: CodeParserKind;
  parse_status: CodeParseStatus;
  kind: string;
  symbol: string | null;
  symbol_key: string | null;
  declaration_key: string | null;
  declaration_chunk_ordinal: number | null;
  symbols: CodeArtifactSymbol[] | null;
  ordinal: number;
  start_line: number;
  end_line: number;
  content: string;
  content_sha256: string;
  dependencies: ReusableDependencyRow[] | null;
}

interface ReusableDependencyRow {
  fromSymbolKey: string | null;
  kind: CodeDependencyKind;
  targetText: string;
  moduleBindings?: PreparedModuleBinding[];
  siteStartLine: number;
  siteStartColumn: number;
  siteEndLine: number;
  siteEndColumn: number;
}

interface VerifiedGitPreparation {
  manifest: GitRevisionManifest;
  treeOid: string;
  artifacts: readonly PreparedArtifact[];
  dependencies: readonly PreparedDependencyEdge[];
  parsedFileCount: number;
  reusedFileCount: number;
}

interface ArtifactSpan {
  start: number;
  end: number;
  anchor: SgNode;
}

interface LanguageSelection {
  language: string;
  parserLanguage: Lang;
}

const execFileAsync = promisify(execFile);

async function gitOutput(repositoryPath: string, arguments_: readonly string[]): Promise<Buffer> {
  try {
    const result = await execFileAsync("git", ["-C", repositoryPath, ...arguments_], {
      encoding: "buffer",
      maxBuffer: CODE_INDEX_LIMITS.maximumSourceBytes + 16 * 1024 * 1024,
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch (error) {
    throw new CodeIndexValidationError("Unable to read the requested Git revision", {
      cause: error,
    });
  }
}

interface GitBlobRequest {
  objectOid: string;
  byteSize: number;
}

async function readGitBlobBatch(
  canonicalPath: string,
  requests: readonly GitBlobRequest[],
): Promise<Map<string, Buffer>> {
  const unique = [...new Map(requests.map((request) => [request.objectOid, request])).values()];
  if (unique.length === 0) return new Map();
  const maximumOutputBytes =
    unique.reduce((total, request) => total + request.byteSize, 0) + unique.length * 200;
  const child = spawn("git", ["-C", canonicalPath, "cat-file", "--batch"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > maximumOutputBytes) child.kill();
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && !signal && outputBytes <= maximumOutputBytes) resolve();
      else
        reject(
          new CodeIndexValidationError("Unable to batch-read Git blobs", {
            cause: new Error(Buffer.concat(stderr).toString("utf8").slice(0, 1_000)),
          }),
        );
    });
  });
  child.stdin.end(`${unique.map((request) => request.objectOid).join("\n")}\n`);
  await completed;

  const output = Buffer.concat(stdout);
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const request of unique) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) throw new CodeIndexValidationError("Git blob batch header is truncated");
    const [objectOid, objectType, sizeText] = output
      .subarray(offset, headerEnd)
      .toString("ascii")
      .split(" ");
    const size = Number(sizeText);
    if (
      objectOid?.toLowerCase() !== request.objectOid ||
      objectType !== "blob" ||
      !Number.isSafeInteger(size) ||
      size !== request.byteSize
    ) {
      throw new CodeIndexValidationError("Git blob batch disagrees with tree metadata");
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length || output[contentEnd] !== 10) {
      throw new CodeIndexValidationError("Git blob batch content is truncated");
    }
    blobs.set(request.objectOid, output.subarray(contentStart, contentEnd));
    offset = contentEnd + 1;
  }
  if (offset !== output.length) {
    throw new CodeIndexValidationError("Git blob batch returned unexpected trailing data");
  }
  return blobs;
}

async function readGitRevisionFiles(
  canonicalPath: string,
  commitOid: string,
): Promise<{ files: CodeSourceFile[]; manifest: GitRevisionManifest }> {
  const tree = await gitOutput(canonicalPath, [
    "ls-tree",
    "-rz",
    "--full-tree",
    "--format=%(objectmode)%x09%(objecttype)%x09%(objectname)%x09%(objectsize)%x09%(path)",
    commitOid,
  ]);
  let treeText: string;
  try {
    treeText = new TextDecoder("utf-8", { fatal: true }).decode(tree);
  } catch (error) {
    throw new CodeIndexValidationError("Git tree contains a path that is not valid UTF-8", {
      cause: error,
    });
  }
  const entries = treeText.split("\0").filter(Boolean);
  type ParsedTreeEntry = {
    path: string;
    mode: string;
    objectType: string;
    objectOid: string;
    byteSize: number | null;
    exclusionReason: GitTreeEntryExclusionReason | null;
  };
  const parsedEntries: ParsedTreeEntry[] = [];
  for (const entry of entries) {
    const [mode, objectType, objectOid, sizeText, ...pathParts] = entry.split("\t");
    const path = validatePath(pathParts.join("\t"));
    if (!mode || !objectType || !objectOid || !sizeText) {
      throw new CodeIndexValidationError(`Malformed Git tree entry: ${path}`);
    }
    const parsedSize = sizeText === "-" ? null : Number(sizeText);
    if (parsedSize !== null && (!Number.isSafeInteger(parsedSize) || parsedSize < 0)) {
      throw new CodeIndexValidationError(`Invalid Git object size for ${path}`);
    }
    let exclusionReason: GitTreeEntryExclusionReason | null = null;
    if (mode === "120000") exclusionReason = "symlink";
    else if (mode === "160000" || objectType === "commit") exclusionReason = "submodule";
    else if (objectType !== "blob" || (mode !== "100644" && mode !== "100755")) {
      exclusionReason = "unsupported";
    } else if (parsedSize === null || parsedSize > CODE_INDEX_LIMITS.maximumFileBytes) {
      exclusionReason = "oversized";
    }
    parsedEntries.push({
      path,
      mode,
      objectType,
      objectOid: objectOid.toLowerCase(),
      byteSize: parsedSize,
      exclusionReason,
    });
  }

  const files: CodeSourceFile[] = [];
  const manifestByPath = new Map<string, GitRevisionManifestEntry>();
  for (const entry of parsedEntries) {
    if (!entry.exclusionReason) continue;
    manifestByPath.set(entry.path, {
      ...entry,
      contentSha256: null,
      status: "excluded",
      exclusionReason: entry.exclusionReason,
    });
  }
  const blobEntries = parsedEntries.filter(
    (entry): entry is ParsedTreeEntry & { byteSize: number } =>
      entry.exclusionReason === null && entry.byteSize !== null,
  );
  const maximumBatchBytes = 32 * 1024 * 1024;
  let sourceBytes = 0;
  for (let cursor = 0; cursor < blobEntries.length; ) {
    const batch: Array<ParsedTreeEntry & { byteSize: number }> = [];
    let batchBytes = 0;
    while (cursor < blobEntries.length) {
      const candidate = blobEntries[cursor];
      if (!candidate) break;
      if (batch.length > 0 && batchBytes + candidate.byteSize > maximumBatchBytes) break;
      batch.push(candidate);
      batchBytes += candidate.byteSize;
      cursor += 1;
    }
    const blobs = await readGitBlobBatch(canonicalPath, batch);
    for (const entry of batch) {
      const contentBytes = blobs.get(entry.objectOid);
      if (!contentBytes || contentBytes.length !== entry.byteSize) {
        throw new CodeIndexValidationError(`${entry.path} bytes disagree with Git tree metadata`);
      }
      const contentSha256 = sha256(contentBytes);
      let exclusionReason: GitTreeEntryExclusionReason | null = null;
      let content: string | null = null;
      if (contentBytes.length === 0) exclusionReason = "empty";
      else if (contentBytes.includes(0)) exclusionReason = "binary";
      else {
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(contentBytes);
        } catch {
          exclusionReason = "invalid_utf8";
        }
      }
      if (content !== null) {
        sourceBytes += contentBytes.length;
        if (files.length >= CODE_INDEX_LIMITS.maximumFiles) {
          throw new CodeIndexValidationError(
            `A revision may contain at most ${CODE_INDEX_LIMITS.maximumFiles} source files`,
          );
        }
        if (sourceBytes > CODE_INDEX_LIMITS.maximumSourceBytes) {
          throw new CodeIndexValidationError(
            `Revision exceeds the ${CODE_INDEX_LIMITS.maximumSourceBytes}-byte source limit`,
          );
        }
        files.push({ path: entry.path, content });
      }
      manifestByPath.set(entry.path, {
        path: entry.path,
        mode: entry.mode,
        objectType: entry.objectType,
        objectOid: entry.objectOid,
        byteSize: entry.byteSize,
        contentSha256,
        status: exclusionReason ? "excluded" : "indexed",
        exclusionReason,
      });
    }
  }
  const manifestEntries = parsedEntries.map((entry) => {
    const outcome = manifestByPath.get(entry.path);
    if (!outcome) {
      throw new CodeIndexValidationError(`Git tree entry ${entry.path} has no indexing outcome`);
    }
    return outcome;
  });
  const validatedFiles = validateAndSortFiles(files);
  return {
    files: validatedFiles,
    manifest: {
      entries: manifestEntries,
      totalEntryCount: manifestEntries.length,
      indexedFileCount: validatedFiles.length,
      excludedFileCount: manifestEntries.length - validatedFiles.length,
    },
  };
}

async function resolveGitTreeOid(canonicalPath: string, commitOid: string): Promise<string> {
  const treeOid = (await gitOutput(canonicalPath, ["rev-parse", "--verify", `${commitOid}^{tree}`]))
    .toString("utf8")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(treeOid)) {
    throw new CodeIndexValidationError("Git commit resolved to an invalid tree OID");
  }
  return treeOid;
}

async function resolveGitCommit(repositoryPath: string, commitOid: string): Promise<string> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(repositoryPath);
  } catch (error) {
    throw new CodeIndexValidationError("repositoryPath must identify a local Git repository", {
      cause: error,
    });
  }
  const resolvedCommit = (
    await gitOutput(canonicalPath, ["rev-parse", "--verify", `${commitOid}^{commit}`])
  )
    .toString("utf8")
    .trim()
    .toLowerCase();
  if (resolvedCommit !== commitOid) {
    throw new CodeIndexValidationError("commitOid did not resolve to the requested exact commit");
  }
  return validatePlainText(canonicalPath, "repositoryPath", 4_096);
}

interface RepositoryRow {
  id: string;
}

interface RevisionRow {
  id: string;
  source_digest: string;
  tree_oid: string | null;
  tree_digest: string | null;
  file_count: number;
}

interface GenerationRow {
  id: string;
  artifact_count: number;
  status: "active" | "building" | "failed" | "ready" | "retiring";
}

interface ActiveGitRevisionRow extends RevisionRow {
  repository_id: string;
  generation_id: string;
  artifact_count: number;
}

interface CodeIndexJobRow {
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

const SYMBOL_KINDS = new Set([
  "abstract_class_declaration",
  "abstract_method_signature",
  "ambient_declaration",
  "class_declaration",
  "enum_declaration",
  "function_declaration",
  "function_signature",
  "generator_function_declaration",
  "interface_declaration",
  "internal_module",
  "method_definition",
  "method_signature",
  "module",
  "type_alias_declaration",
  "variable_declarator",
]);

const FORCE_CHILDREN_KINDS = new Set([
  "abstract_class_declaration",
  "class_body",
  "class_declaration",
  "document",
  "export_statement",
  "interface_declaration",
  "internal_module",
  "lexical_declaration",
  "object_type",
  "program",
  "stylesheet",
  "variable_declaration",
]);

function nodeKind(node: SgNode): string {
  return String(node.kind());
}

function isSymbolNode(node: SgNode): boolean {
  const kind = nodeKind(node);
  if (!SYMBOL_KINDS.has(kind)) return false;
  if (kind !== "variable_declarator") return true;
  return !node
    .ancestors()
    .some((ancestor) =>
      [
        "arrow_function",
        "function_expression",
        "function_declaration",
        "generator_function",
        "generator_function_declaration",
        "method_definition",
      ].includes(nodeKind(ancestor)),
    );
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function languageForPath(path: string): LanguageSelection | null {
  switch (extname(path).toLowerCase()) {
    case ".ts":
    case ".cts":
    case ".mts":
      return { language: "typescript", parserLanguage: Lang.TypeScript };
    case ".tsx":
      return { language: "tsx", parserLanguage: Lang.Tsx };
    case ".js":
    case ".cjs":
    case ".mjs":
      return { language: "javascript", parserLanguage: Lang.JavaScript };
    case ".jsx":
      return { language: "jsx", parserLanguage: Lang.JavaScript };
    case ".css":
      return { language: "css", parserLanguage: Lang.Css };
    case ".html":
    case ".htm":
    case ".xhtml":
      return { language: "html", parserLanguage: Lang.Html };
    default:
      return null;
  }
}

function fallbackLanguage(path: string): string {
  const extension = extname(path).toLowerCase().slice(1);
  return extension || "text";
}

function validateCommitOid(commitOid: string): string {
  const normalized = commitOid.trim().toLowerCase();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(normalized)) {
    throw new CodeIndexValidationError("commitOid must be a full 40- or 64-character Git OID");
  }
  return normalized;
}

function validateUuid(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
  ) {
    throw new CodeIndexValidationError(`${name} must be a UUID`);
  }
  return normalized;
}

function validatePlainText(value: string, name: string, maximumLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || hasControlCharacters(normalized)) {
    throw new CodeIndexValidationError(`${name} is invalid`);
  }
  return normalized;
}

function validatePath(path: string): string {
  const normalized = path.trim();
  if (
    !normalized ||
    normalized !== path ||
    normalized.length > 1_024 ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    hasControlCharacters(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new CodeIndexValidationError(`Invalid repository-relative path: ${path}`);
  }
  return normalized;
}

function validateAndSortFiles(files: readonly CodeSourceFile[]): CodeSourceFile[] {
  if (files.length > CODE_INDEX_LIMITS.maximumFiles) {
    throw new CodeIndexValidationError(
      `A revision may contain at most ${CODE_INDEX_LIMITS.maximumFiles} source files`,
    );
  }
  const paths = new Set<string>();
  let sourceBytes = 0;
  const validated = files.map((file) => {
    const path = validatePath(file.path);
    if (paths.has(path)) throw new CodeIndexValidationError(`Duplicate source path: ${path}`);
    paths.add(path);
    if (file.content.includes("\0")) {
      throw new CodeIndexValidationError(`${path} contains a NUL byte and is not text source`);
    }
    const fileBytes = Buffer.byteLength(file.content, "utf8");
    if (fileBytes > CODE_INDEX_LIMITS.maximumFileBytes) {
      throw new CodeIndexValidationError(
        `${path} exceeds the ${CODE_INDEX_LIMITS.maximumFileBytes}-byte file limit`,
      );
    }
    sourceBytes += fileBytes;
    return { path, content: file.content };
  });
  if (sourceBytes > CODE_INDEX_LIMITS.maximumSourceBytes) {
    throw new CodeIndexValidationError(
      `Revision exceeds the ${CODE_INDEX_LIMITS.maximumSourceBytes}-byte source limit`,
    );
  }
  return validated.sort((left, right) => left.path.localeCompare(right.path));
}

function digestFiles(files: readonly CodeSourceFile[]): string {
  const digest = createHash("sha256");
  for (const file of files) {
    const pathBytes = Buffer.byteLength(file.path, "utf8");
    const contentBytes = Buffer.byteLength(file.content, "utf8");
    digest.update(`${pathBytes}:`);
    digest.update(file.path);
    digest.update(`${contentBytes}:`);
    digest.update(file.content);
  }
  return digest.digest("hex");
}

function digestGitManifest(manifest: GitRevisionManifest): string {
  const digest = createHash("sha256");
  for (const entry of [...manifest.entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    for (const value of [
      entry.path,
      entry.mode,
      entry.objectType,
      entry.objectOid,
      entry.byteSize?.toString() ?? "-",
      entry.contentSha256 ?? "-",
      entry.status,
      entry.exclusionReason ?? "-",
    ]) {
      digest.update(`${Buffer.byteLength(value, "utf8")}:`);
      digest.update(value);
    }
  }
  return digest.digest("hex");
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineNumberAt(starts: readonly number[], position: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? 0) <= position) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function lineRange(
  starts: readonly number[],
  start: number,
  end: number,
): { startLine: number; endLine: number } {
  return {
    startLine: lineNumberAt(starts, start),
    endLine: lineNumberAt(starts, Math.max(start, end - 1)),
  };
}

function codePointBoundary(content: string, boundary: number, end: number): number {
  if (boundary >= end) return boundary;
  const previous = content.charCodeAt(boundary - 1);
  const next = content.charCodeAt(boundary);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? boundary - 1
    : boundary;
}

function hardSplitSpan(
  content: string,
  start: number,
  end: number,
  anchor: SgNode,
): ArtifactSpan[] {
  const spans: ArtifactSpan[] = [];
  let cursor = start;
  while (cursor < end) {
    let boundary = Math.min(end, cursor + CODE_INDEX_LIMITS.maximumArtifactCodeUnits);
    if (boundary < end) {
      const newline = content.lastIndexOf("\n", boundary - 1);
      if (newline > cursor) boundary = newline + 1;
    }
    if (boundary <= cursor) {
      boundary = Math.min(end, cursor + CODE_INDEX_LIMITS.maximumArtifactCodeUnits);
    }
    boundary = codePointBoundary(content, boundary, end);
    spans.push({ start: cursor, end: boundary, anchor });
    cursor = boundary;
  }
  return spans;
}

function mergeSpans(spans: readonly ArtifactSpan[], parent: SgNode): ArtifactSpan[] {
  const merged: ArtifactSpan[] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (
      previous &&
      !firstNamedSymbol(previous.anchor) &&
      !firstNamedSymbol(span.anchor) &&
      span.end - previous.start <= CODE_INDEX_LIMITS.maximumArtifactCodeUnits
    ) {
      previous.end = span.end;
      previous.anchor = parent;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function attachLeadingComments(content: string, spans: readonly ArtifactSpan[]): ArtifactSpan[] {
  const attached: ArtifactSpan[] = [];
  for (const original of spans) {
    const span = { ...original };
    if (symbolForSpan(span.anchor)) {
      while (attached.length > 0) {
        const previous = attached.at(-1);
        if (!previous) break;
        if (
          nodeKind(previous.anchor) !== "comment" ||
          content.slice(previous.end, span.start).trim() ||
          span.end - previous.start > CODE_INDEX_LIMITS.maximumArtifactCodeUnits
        ) {
          break;
        }
        attached.pop();
        span.start = previous.start;
      }
    }
    attached.push(span);
  }
  return attached;
}

function partitionSpanRange(
  content: string,
  spans: readonly ArtifactSpan[],
  start: number,
  end: number,
): ArtifactSpan[] {
  const partitioned = spans.map((span) => ({ ...span }));
  const first = partitioned[0];
  const last = partitioned.at(-1);
  if (!first || !last) return partitioned;
  first.start = start;
  for (let index = 0; index < partitioned.length - 1; index += 1) {
    const current = partitioned[index];
    const next = partitioned[index + 1];
    if (current && next) {
      const gap = content.slice(current.end, next.start);
      const lastTokenOffset = gap.search(/\s*$/);
      const boundary = current.end + lastTokenOffset;
      current.end = boundary;
      next.start = boundary;
    }
  }
  last.end = end;
  return partitioned;
}

function structuralSpans(content: string, node: SgNode): ArtifactSpan[] {
  const range = node.range();
  const start = range.start.index;
  const end = range.end.index;
  const forceChildren = FORCE_CHILDREN_KINDS.has(nodeKind(node));
  if (end - start <= CODE_INDEX_LIMITS.maximumArtifactCodeUnits && !forceChildren) {
    return [{ start, end, anchor: node }];
  }

  const namedChildren = node
    .children()
    .filter((child) => child.isNamed() && child.range().end.index > child.range().start.index);
  if (namedChildren.length === 0) return hardSplitSpan(content, start, end, node);

  const childSpans = attachLeadingComments(
    content,
    namedChildren.flatMap((child) => structuralSpans(content, child)),
  );
  if (childSpans.length === 0) return hardSplitSpan(content, start, end, node);
  const partitioned = partitionSpanRange(content, childSpans, start, end);
  return mergeSpans(partitioned, node).flatMap((span) =>
    span.end - span.start > CODE_INDEX_LIMITS.maximumArtifactCodeUnits
      ? hardSplitSpan(content, span.start, span.end, span.anchor)
      : [span],
  );
}

function firstNamedSymbol(node: SgNode): SgNode | null {
  if (isSymbolNode(node)) return node;
  const found: SgNode[] = [];
  const visit = (candidate: SgNode) => {
    if (isSymbolNode(candidate)) {
      found.push(candidate);
      return;
    }
    for (const child of candidate.children()) {
      if (child.isNamed()) visit(child);
      if (found.length > 1) return;
    }
  };
  visit(node);
  return found.length === 1 ? (found[0] ?? null) : null;
}

function symbolName(node: SgNode): string | null {
  const fieldName = node.field("name");
  if (fieldName) return fieldName.text().trim() || null;
  for (const child of node.children()) {
    if (
      child.isNamed() &&
      ["identifier", "property_identifier", "type_identifier"].includes(nodeKind(child))
    ) {
      return child.text().trim() || null;
    }
  }
  return null;
}

function bindingNames(node: SgNode | null): string[] {
  if (!node) return [];
  const kind = nodeKind(node);
  if (
    kind === "identifier" ||
    kind === "shorthand_property_identifier_pattern" ||
    kind === "shorthand_property_identifier"
  ) {
    const name = node.text().trim();
    return name ? [name] : [];
  }
  const namedChildren = node.children().filter((child) => child.isNamed());
  if (kind === "pair_pattern") {
    return bindingNames(namedChildren.at(-1) ?? null);
  }
  if (kind === "assignment_pattern" || kind === "rest_pattern") {
    return bindingNames(namedChildren[0] ?? null);
  }
  if (kind === "property_identifier" || kind === "computed_property_name") return [];
  return [...new Set(namedChildren.flatMap(bindingNames))];
}

function symbolForSpan(anchor: SgNode): { node: SgNode; symbols: string[]; kind: string } | null {
  const lineage = [anchor, ...anchor.ancestors()];
  const nearestAncestor = lineage.find(isSymbolNode);
  const selected = nearestAncestor ?? firstNamedSymbol(anchor);
  if (!selected) return null;

  const ancestorNames = [...selected.ancestors()]
    .reverse()
    .filter(isSymbolNode)
    .map(symbolName)
    .filter((name): name is string => Boolean(name));
  const selectedNames =
    nodeKind(selected) === "variable_declarator"
      ? bindingNames(selected.field("name"))
      : [symbolName(selected)].filter((name): name is string => Boolean(name));
  const symbols = selectedNames.map((name) => [...ancestorNames, name].join("."));
  if (symbols.length === 0) return null;
  return { node: selected, symbols, kind: nodeKind(selected) };
}

function parserErrorCoverage(root: SgNode): number {
  const rootRange = root.range();
  const rootLength = Math.max(1, rootRange.end.index - rootRange.start.index);
  const errors = root.findAll({ rule: { kind: "ERROR" } });
  if (errors.length === 0) return 0;
  const ranges = errors
    .map((error) => [error.range().start.index, error.range().end.index] as const)
    .sort((left, right) => left[0] - right[0]);
  let covered = 0;
  const firstRange = ranges[0];
  if (!firstRange) return 0;
  let [start, end] = firstRange;
  for (const [nextStart, nextEnd] of ranges.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
    } else {
      covered += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }
  covered += end - start;
  return covered / rootLength;
}

function fallbackSpans(content: string): Array<{ start: number; end: number }> {
  if (!content) return [];
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < content.length) {
    let boundary = Math.min(content.length, cursor + CODE_INDEX_LIMITS.maximumArtifactCodeUnits);
    if (boundary < content.length) {
      const newline = content.lastIndexOf("\n", boundary - 1);
      if (newline > cursor) boundary = newline + 1;
    }
    if (boundary <= cursor) {
      boundary = Math.min(content.length, cursor + CODE_INDEX_LIMITS.maximumArtifactCodeUnits);
    }
    boundary = codePointBoundary(content, boundary, content.length);
    spans.push({ start: cursor, end: boundary });
    cursor = boundary;
  }
  return spans;
}

function artifactsFromSpans(
  path: string,
  content: string,
  language: string,
  spans: readonly ArtifactSpan[],
  parseStatus: CodeParseStatus,
): PreparedArtifact[] {
  const declarationKeys = new Map<string, string>();
  const declarationOccurrences = new Map<string, number>();
  const declarationChunkOrdinals = new Map<number, number>();
  const starts = lineStarts(content);
  return spans.flatMap((span, ordinal) => {
    const selectedContent = content.slice(span.start, span.end);
    if (!selectedContent) return [];
    const identified = symbolForSpan(span.anchor);
    const symbols: CodeArtifactSymbol[] = [];
    const declarationChunkOrdinal = identified
      ? (declarationChunkOrdinals.get(identified.node.id()) ?? 0)
      : null;
    if (identified) {
      declarationChunkOrdinals.set(identified.node.id(), (declarationChunkOrdinal ?? 0) + 1);
      for (const symbol of identified.symbols) {
        const symbolKey = `${path}#${identified.kind}:${symbol}`;
        const nodeSymbolKey = `${identified.node.id()}:${symbolKey}`;
        let declarationKey = declarationKeys.get(nodeSymbolKey);
        if (!declarationKey) {
          const occurrence = declarationOccurrences.get(symbolKey) ?? 0;
          declarationOccurrences.set(symbolKey, occurrence + 1);
          declarationKey = occurrence === 0 ? symbolKey : `${symbolKey}~${occurrence + 1}`;
          declarationKeys.set(nodeSymbolKey, declarationKey);
        }
        symbols.push({ declarationKey, symbol, symbolKey });
      }
    }
    const primarySymbol = symbols[0] ?? null;
    const lines = lineRange(starts, span.start, span.end);
    return [
      {
        path,
        language,
        parser: "tree_sitter" as const,
        parseStatus,
        kind: identified?.kind ?? nodeKind(span.anchor),
        symbol: primarySymbol?.symbol ?? null,
        symbolKey: primarySymbol?.symbolKey ?? null,
        declarationKey: primarySymbol?.declarationKey ?? null,
        declarationChunkOrdinal,
        symbols,
        ordinal,
        startIndex: span.start,
        endIndex: span.end,
        ...lines,
        content: selectedContent,
        contentSha256: sha256(selectedContent),
      },
    ];
  });
}

function fallbackArtifacts(path: string, content: string, language: string): PreparedArtifact[] {
  const starts = lineStarts(content);
  return fallbackSpans(content).map((span, ordinal) => {
    const selectedContent = content.slice(span.start, span.end);
    return {
      path,
      language,
      parser: "text",
      parseStatus: "fallback",
      kind: "text_chunk",
      symbol: null,
      symbolKey: null,
      declarationKey: null,
      declarationChunkOrdinal: null,
      symbols: [],
      ordinal,
      startIndex: span.start,
      endIndex: span.end,
      ...lineRange(starts, span.start, span.end),
      content: selectedContent,
      contentSha256: sha256(selectedContent),
    };
  });
}

function descendantsOfKind(node: SgNode, kind: string): SgNode[] {
  const matches: SgNode[] = [];
  const stack = [...node.children().reverse()];
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate) continue;
    if (nodeKind(candidate) === kind) matches.push(candidate);
    stack.push(...candidate.children().reverse());
  }
  return matches;
}

function moduleSpecifier(node: SgNode): string | null {
  const source = node.field("source")?.text().trim() ?? "";
  const unquoted =
    source.length >= 2 &&
    ((source.startsWith('"') && source.endsWith('"')) ||
      (source.startsWith("'") && source.endsWith("'")) ||
      (source.startsWith("`") && source.endsWith("`")))
      ? source.slice(1, -1)
      : source;
  return unquoted || null;
}

function importBindings(node: SgNode): PreparedModuleBinding[] {
  const clause = descendantsOfKind(node, "import_clause")[0];
  if (!clause) return [];
  const bindings: PreparedModuleBinding[] = [];
  for (const child of clause.children().filter((candidate) => candidate.isNamed())) {
    const kind = nodeKind(child);
    if (kind === "identifier") {
      const localName = child.text().trim();
      if (localName) bindings.push({ kind: "default", localName, importedName: "default" });
    } else if (kind === "named_imports") {
      for (const specifier of descendantsOfKind(child, "import_specifier")) {
        const identifiers = descendantsOfKind(specifier, "identifier")
          .map((identifier) => identifier.text().trim())
          .filter(Boolean);
        const importedName = identifiers[0];
        const localName = identifiers.at(-1);
        if (importedName && localName) bindings.push({ kind: "named", importedName, localName });
      }
    } else if (kind === "namespace_import") {
      const localName = descendantsOfKind(child, "identifier")[0]?.text().trim();
      if (localName) bindings.push({ kind: "namespace", localName });
    }
  }
  return bindings;
}

function reexportBindings(node: SgNode): PreparedModuleBinding[] {
  const clause = descendantsOfKind(node, "export_clause")[0];
  if (!clause) return [{ kind: "reexport_all" }];
  return descendantsOfKind(clause, "export_specifier").flatMap((specifier) => {
    const identifiers = descendantsOfKind(specifier, "identifier")
      .map((identifier) => identifier.text().trim())
      .filter(Boolean);
    const importedName = identifiers[0];
    const exportedName = identifiers.at(-1);
    return importedName && exportedName
      ? [{ kind: "reexport_named" as const, importedName, exportedName }]
      : [];
  });
}

function dependencyEdgesFromTree(
  path: string,
  root: SgNode,
  artifacts: readonly PreparedArtifact[],
): PreparedDependencyEdge[] {
  const dependencies: PreparedDependencyEdge[] = [];
  const appendDependency = (
    node: SgNode,
    kind: CodeDependencyKind,
    targetText: string,
    moduleBindings: readonly PreparedModuleBinding[] = [],
  ): void => {
    const normalizedTarget = targetText.trim();
    const range = node.range();
    const fromArtifact = artifacts.find(
      (artifact) =>
        artifact.startIndex <= range.start.index && range.start.index < artifact.endIndex,
    );
    if (
      !fromArtifact ||
      !normalizedTarget ||
      normalizedTarget.length > 1_600 ||
      hasControlCharacters(normalizedTarget)
    ) {
      return;
    }
    dependencies.push({
      path,
      fromArtifactOrdinal: fromArtifact.ordinal,
      fromSymbolKey: (() => {
        const identified = symbolForSpan(node);
        const symbol = identified?.symbols[0];
        if (!identified || !symbol) return null;
        const symbolKey = `${path}#${identified.kind}:${symbol}`;
        return fromArtifact.symbols.some((artifactSymbol) => artifactSymbol.symbolKey === symbolKey)
          ? symbolKey
          : null;
      })(),
      kind,
      targetText: normalizedTarget,
      moduleBindings,
      siteStartLine: range.start.line + 1,
      siteStartColumn: range.start.column,
      siteEndLine: range.end.line + 1,
      siteEndColumn: range.end.column,
    });
  };
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    const kind = nodeKind(node);
    if (kind === "call_expression") {
      const target = node.field("function");
      if (target) appendDependency(node, "calls", target.text());
    } else if (kind === "import_statement") {
      const source = moduleSpecifier(node);
      if (source) appendDependency(node, "imports", source, importBindings(node));
    } else if (kind === "export_statement") {
      const source = moduleSpecifier(node);
      if (source) appendDependency(node, "imports", source, reexportBindings(node));
    } else if (kind === "type_identifier") {
      const isDefinitionName = node.ancestors().some((ancestor) => {
        if (!isSymbolNode(ancestor)) return false;
        return ancestor.field("name")?.id() === node.id();
      });
      if (!isDefinitionName) appendDependency(node, "references", node.text());
    } else if (kind === "jsx_opening_element" || kind === "jsx_self_closing_element") {
      const target =
        node
          .children()
          .find((child) => child.isNamed())
          ?.text()
          .trim() ?? "";
      if (/^[A-Z]/.test(target)) appendDependency(node, "references", target);
    }
    stack.push(...node.children().reverse());
  }
  return dependencies;
}

async function prepareFile(file: CodeSourceFile): Promise<PreparedFileIndex> {
  const selection = languageForPath(file.path);
  if (!selection) {
    return {
      artifacts: fallbackArtifacts(file.path, file.content, fallbackLanguage(file.path)),
      dependencies: [],
    };
  }
  if (!file.content) return { artifacts: [], dependencies: [] };
  try {
    const root = (await parseAsync(selection.parserLanguage, file.content)).root();
    const errorCoverage = parserErrorCoverage(root);
    if (errorCoverage > 0.25) {
      return {
        artifacts: fallbackArtifacts(file.path, file.content, selection.language),
        dependencies: [],
      };
    }
    const artifacts = artifactsFromSpans(
      file.path,
      file.content,
      selection.language,
      structuralSpans(file.content, root),
      errorCoverage > 0 ? "recovered" : "parsed",
    );
    return {
      artifacts,
      dependencies: dependencyEdgesFromTree(file.path, root, artifacts),
    };
  } catch {
    return {
      artifacts: fallbackArtifacts(file.path, file.content, selection.language),
      dependencies: [],
    };
  }
}

async function mapConcurrent<Input, Result>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) break;
      results[index] = await map(value);
    }
  });
  await Promise.all(workers);
  return results;
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

async function loadReusableGitFiles(
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

async function insertArtifactBatch(
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

async function insertDependencyEdges(
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

async function insertGitManifest(
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

function toCodeIndexJob(row: CodeIndexJobRow): CodeIndexJob {
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

interface CodeIndexMaintenanceLeaseContext {
  jobId: string;
  leaseToken: string;
  repositoryId: string;
}

interface CodeIndexModuleOptions {
  maintenanceLease?: CodeIndexMaintenanceLeaseContext;
}

export function createCodeIndexModule(
  database: PostgresDatabase,
  options: CodeIndexModuleOptions = {},
): CodeIndexModule {
  const reader = createCodeIndexReadModule(database);
  const maintenanceLease = options.maintenanceLease ?? null;
  async function installModuleContext(
    transaction: PostgresTransaction,
    actor: ActorContext,
  ): Promise<void> {
    await installActorContext(transaction, actor);
    if (maintenanceLease) {
      await transaction.query(
        `SELECT
           set_config('lore.code_index_job_id', $1, true),
           set_config('lore.code_index_lease_token', $2, true)`,
        [maintenanceLease.jobId, maintenanceLease.leaseToken],
      );
    }
  }
  const verifiedGitPreparations = new WeakMap<IndexCodeRevisionInput, VerifiedGitPreparation>();

  async function findActiveGitRevision(
    actor: ActorContext,
    repositoryKey: string,
    commitOid: string,
    treeOid: string,
  ): Promise<ActiveGitRevisionRow | null> {
    if (maintenanceLease) return null;
    return database.transaction(async (transaction) => {
      await installModuleContext(transaction, actor);
      const result = await transaction.query<ActiveGitRevisionRow>(
        `SELECT revision.id, revision.repository_id, revision.source_digest,
           revision.tree_oid, revision.tree_digest, revision.file_count,
           generation.id AS generation_id, generation.artifact_count
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
           AND revision.tree_oid = $4
           AND revision.tree_digest IS NOT NULL
           AND generation.indexer_revision = $5
           AND generation.status = 'active'`,
        [actor.workspaceId, repositoryKey, commitOid, treeOid, CODE_INDEX_REVISION],
      );
      return result.rows[0] ?? null;
    });
  }

  async function persistGitRevisionResumably(
    actor: ActorContext,
    input: IndexCodeRevisionInput,
    preparation: VerifiedGitPreparation,
  ): Promise<IndexedCodeRevision> {
    if (!maintenanceLease) {
      throw new Error("Resumable Code Index persistence requires a maintenance lease");
    }
    const repositoryKey = validatePlainText(input.repositoryKey, "repositoryKey", 512);
    const commitOid = validateCommitOid(input.commitOid);
    const sourceRef = input.sourceRef ? validatePlainText(input.sourceRef, "sourceRef", 512) : null;
    const files = validateAndSortFiles(input.files);
    const sourceDigest = digestFiles(files);
    const treeDigest = digestGitManifest(preparation.manifest);
    const artifacts = [...preparation.artifacts];
    const dependencies = [...preparation.dependencies];
    if (artifacts.length > CODE_INDEX_LIMITS.maximumArtifacts) {
      throw new CodeIndexValidationError(
        `Revision produced more than ${CODE_INDEX_LIMITS.maximumArtifacts} artifacts`,
      );
    }
    const staged = await database.transaction(async (transaction) => {
      await installModuleContext(transaction, actor);
      const allowed = await transaction.query<{ allowed: boolean }>(
        "SELECT lore.can_maintain_code_index($1, $2) AS allowed",
        [actor.workspaceId, maintenanceLease.repositoryId],
      );
      if (!allowed.rows[0]?.allowed) {
        throw new CodeIndexAccessDeniedError("Maintenance lease cannot index this repository");
      }
      const repository = await transaction.query<RepositoryRow>(
        `SELECT id FROM code_repositories
         WHERE workspace_id = $1 AND id = $2 AND repository_key = $3`,
        [actor.workspaceId, maintenanceLease.repositoryId, repositoryKey],
      );
      const repositoryId = repository.rows[0]?.id;
      if (!repositoryId) {
        throw new CodeIndexAccessDeniedError("Repository is not visible to this maintenance lease");
      }
      const insertedRevision = await transaction.query<RevisionRow>(
        `INSERT INTO code_revisions (
           id, workspace_id, repository_id, commit_oid, source_ref,
           source_digest, tree_oid, tree_digest, file_count,
           discovered_by_user_id, discovered_by_agent_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (repository_id, commit_oid) DO NOTHING
         RETURNING id, source_digest, tree_oid, tree_digest, file_count`,
        [
          crypto.randomUUID(),
          actor.workspaceId,
          repositoryId,
          commitOid,
          sourceRef,
          sourceDigest,
          preparation.treeOid,
          treeDigest,
          files.length,
          actor.userId,
          actor.agentId ?? null,
        ],
      );
      const revisionWasInserted = insertedRevision.rows.length === 1;
      let revision = insertedRevision.rows[0];
      if (!revision) {
        const existing = await transaction.query<RevisionRow>(
          `SELECT id, source_digest, tree_oid, tree_digest, file_count
           FROM code_revisions
           WHERE workspace_id = $1 AND repository_id = $2 AND commit_oid = $3`,
          [actor.workspaceId, repositoryId, commitOid],
        );
        revision = existing.rows[0];
      }
      if (!revision) {
        throw new CodeIndexAccessDeniedError("Revision is not visible to this maintenance lease");
      }
      if (
        revision.source_digest !== sourceDigest ||
        revision.tree_oid !== preparation.treeOid ||
        revision.tree_digest !== treeDigest
      ) {
        throw new CodeRevisionConflictError(
          "The commit OID is already indexed with different source or Git tree evidence",
        );
      }
      if (revisionWasInserted) {
        await insertGitManifest(
          transaction,
          actor,
          repositoryId,
          revision.id,
          preparation.manifest,
        );
      }
      const generationId = crypto.randomUUID();
      const insertedGeneration = await transaction.query<GenerationRow>(
        `INSERT INTO code_index_generations (
           id, workspace_id, repository_id, revision_id, indexer_revision,
           status, artifact_count, indexed_by_user_id, indexed_by_agent_id
         ) VALUES ($1, $2, $3, $4, $5, 'building', $6, $7, $8)
         ON CONFLICT (revision_id, indexer_revision) DO NOTHING
         RETURNING id, artifact_count, status`,
        [
          generationId,
          actor.workspaceId,
          repositoryId,
          revision.id,
          CODE_INDEX_REVISION,
          artifacts.length,
          actor.userId,
          actor.agentId ?? null,
        ],
      );
      let generation = insertedGeneration.rows[0];
      if (!generation) {
        const existing = await transaction.query<GenerationRow>(
          `SELECT id, artifact_count, status
           FROM code_index_generations
           WHERE workspace_id = $1 AND repository_id = $2
             AND revision_id = $3 AND indexer_revision = $4`,
          [actor.workspaceId, repositoryId, revision.id, CODE_INDEX_REVISION],
        );
        generation = existing.rows[0];
      }
      if (!generation) {
        throw new CodeIndexAccessDeniedError(
          "Index generation is not visible to this maintenance lease",
        );
      }
      if (generation.artifact_count !== artifacts.length) {
        throw new CodeRevisionConflictError(
          "The existing Code Index generation expects a different Artifact count",
        );
      }
      if (generation.status === "failed") {
        throw new CodeIndexValidationError("Failed Code Index generation cannot be resumed");
      }
      if (generation.status === "ready" || generation.status === "retiring") {
        await transaction.query("SELECT lore.activate_code_index_generation($1)", [generation.id]);
        generation = { ...generation, status: "active" };
      }
      return { generation, repositoryId, revision };
    });

    if (staged.generation.status !== "active") {
      for (const file of files) {
        const fileArtifacts = artifacts.filter((artifact) => artifact.path === file.path);
        await database.transaction(async (transaction) => {
          await installModuleContext(transaction, actor);
          await insertArtifactBatch(
            transaction,
            actor,
            staged.repositoryId,
            staged.revision.id,
            staged.generation.id,
            fileArtifacts,
            dependencies.filter((dependency) => dependency.path === file.path),
          );
        });
      }
      await database.transaction(async (transaction) => {
        await installModuleContext(transaction, actor);
        await insertDependencyEdges(
          transaction,
          actor,
          staged.repositoryId,
          staged.revision.id,
          staged.generation.id,
          dependencies,
        );
        await transaction.query("SELECT lore.ready_code_index_generation($1)", [
          staged.generation.id,
        ]);
        await transaction.query("SELECT lore.activate_code_index_generation($1)", [
          staged.generation.id,
        ]);
      });
    }
    return {
      revisionId: staged.revision.id,
      generationId: staged.generation.id,
      repositoryId: staged.repositoryId,
      repositoryKey,
      commitOid,
      indexerRevision: CODE_INDEX_REVISION,
      sourceDigest,
      fileCount: staged.revision.file_count,
      artifactCount: artifacts.length,
      reused: staged.generation.status === "active",
    };
  }

  const module: CodeIndexModule = {
    async enqueueGitRevision(actor, input) {
      const repositoryKey = validatePlainText(input.repositoryKey, "repositoryKey", 512);
      const displayName = validatePlainText(input.displayName, "displayName", 200);
      const commitOid = validateCommitOid(input.commitOid);
      const sourceRef = input.sourceRef
        ? validatePlainText(input.sourceRef, "sourceRef", 512)
        : null;
      const repositoryPath = await resolveGitCommit(input.repositoryPath, commitOid);
      try {
        return await database.transaction(async (transaction) => {
          await installModuleContext(transaction, actor);
          const allowed = await transaction.query<{ allowed: boolean }>(
            "SELECT lore.can_write_code_index($1) AS allowed",
            [actor.workspaceId],
          );
          if (!allowed.rows[0]?.allowed) {
            throw new CodeIndexAccessDeniedError("Actor cannot queue code in this Workspace");
          }
          const insertedRepository = await transaction.query<RepositoryRow>(
            `INSERT INTO code_repositories (
               id, workspace_id, repository_key, display_name,
               created_by_user_id, created_by_agent_id
             ) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (workspace_id, repository_key) DO NOTHING
             RETURNING id`,
            [
              crypto.randomUUID(),
              actor.workspaceId,
              repositoryKey,
              displayName,
              actor.userId,
              actor.agentId ?? null,
            ],
          );
          let repositoryId = insertedRepository.rows[0]?.id;
          if (!repositoryId) {
            const existingRepository = await transaction.query<RepositoryRow>(
              `SELECT id
               FROM code_repositories
               WHERE workspace_id = $1 AND repository_key = $2`,
              [actor.workspaceId, repositoryKey],
            );
            repositoryId = existingRepository.rows[0]?.id;
          }
          if (!repositoryId) {
            throw new CodeIndexAccessDeniedError("Repository is not visible to this Actor");
          }
          await transaction.query(
            `INSERT INTO code_index_jobs (
               id, workspace_id, repository_id, repository_path, commit_oid,
               source_ref, indexer_revision, requested_by_user_id,
               requested_by_agent_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (repository_id, commit_oid, indexer_revision) DO NOTHING`,
            [
              crypto.randomUUID(),
              actor.workspaceId,
              repositoryId,
              repositoryPath,
              commitOid,
              sourceRef,
              CODE_INDEX_REVISION,
              actor.userId,
              actor.agentId ?? null,
            ],
          );
          const queued = await transaction.query<CodeIndexJobRow>(
            `SELECT job.id, job.repository_id, repository.repository_key,
               job.commit_oid, job.source_ref, job.indexer_revision, job.status,
               job.attempt_count, job.max_attempts, job.available_at,
               job.completed_at, job.last_error, job.created_at, job.updated_at
             FROM code_index_jobs job
             JOIN code_repositories repository
               ON repository.workspace_id = job.workspace_id
              AND repository.id = job.repository_id
             WHERE job.workspace_id = $1
               AND job.repository_id = $2
               AND job.commit_oid = $3
               AND job.indexer_revision = $4`,
            [actor.workspaceId, repositoryId, commitOid, CODE_INDEX_REVISION],
          );
          const job = queued.rows[0];
          if (!job) throw new CodeIndexAccessDeniedError("Index job is not visible to this Actor");
          return toCodeIndexJob(job);
        });
      } catch (error) {
        if (
          error instanceof CodeIndexAccessDeniedError ||
          error instanceof CodeIndexValidationError
        ) {
          throw error;
        }
        if (isPostgresAccessDenied(error)) {
          throw new CodeIndexAccessDeniedError("Actor cannot queue code in this Workspace", {
            cause: error,
          });
        }
        throw error;
      }
    },

    getIndexJob: reader.getIndexJob,

    async indexRevision(actor, input) {
      const repositoryKey = validatePlainText(input.repositoryKey, "repositoryKey", 512);
      const displayName = validatePlainText(input.displayName, "displayName", 200);
      const commitOid = validateCommitOid(input.commitOid);
      const sourceRef = input.sourceRef
        ? validatePlainText(input.sourceRef, "sourceRef", 512)
        : null;
      const files = validateAndSortFiles(input.files);
      const sourceDigest = digestFiles(files);
      const gitPreparation = verifiedGitPreparations.get(input) ?? null;
      const gitManifest = gitPreparation?.manifest ?? null;
      const treeDigest = gitManifest ? digestGitManifest(gitManifest) : null;
      const preparedFiles = gitPreparation
        ? null
        : await mapConcurrent(files, CODE_INDEX_LIMITS.parserConcurrency, prepareFile);
      const artifacts = gitPreparation
        ? [...gitPreparation.artifacts]
        : (preparedFiles ?? []).flatMap((prepared) => prepared.artifacts);
      const dependencies = gitPreparation
        ? [...gitPreparation.dependencies]
        : (preparedFiles ?? []).flatMap((prepared) => prepared.dependencies);
      if (artifacts.length > CODE_INDEX_LIMITS.maximumArtifacts) {
        throw new CodeIndexValidationError(
          `Revision produced more than ${CODE_INDEX_LIMITS.maximumArtifacts} artifacts`,
        );
      }

      try {
        return await database.transaction(async (transaction) => {
          await installModuleContext(transaction, actor);
          const allowed = maintenanceLease
            ? await transaction.query<{ allowed: boolean }>(
                "SELECT lore.can_maintain_code_index($1, $2) AS allowed",
                [actor.workspaceId, maintenanceLease.repositoryId],
              )
            : await transaction.query<{ allowed: boolean }>(
                "SELECT lore.can_write_code_index($1) AS allowed",
                [actor.workspaceId],
              );
          if (!allowed.rows[0]?.allowed) {
            throw new CodeIndexAccessDeniedError("Actor cannot index code in this Workspace");
          }

          const insertedRepository = maintenanceLease
            ? { rows: [] as RepositoryRow[] }
            : await transaction.query<RepositoryRow>(
                `INSERT INTO code_repositories (
                   id, workspace_id, repository_key, display_name,
                   created_by_user_id, created_by_agent_id
                 ) VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (workspace_id, repository_key) DO NOTHING
                 RETURNING id`,
                [
                  crypto.randomUUID(),
                  actor.workspaceId,
                  repositoryKey,
                  displayName,
                  actor.userId,
                  actor.agentId ?? null,
                ],
              );
          let repositoryId = insertedRepository.rows[0]?.id;
          if (!repositoryId) {
            const existingRepository = await transaction.query<RepositoryRow>(
              `SELECT id
               FROM code_repositories
               WHERE workspace_id = $1 AND repository_key = $2
                 AND ($3::uuid IS NULL OR id = $3)`,
              [actor.workspaceId, repositoryKey, maintenanceLease?.repositoryId ?? null],
            );
            repositoryId = existingRepository.rows[0]?.id;
          }
          if (!repositoryId) {
            throw new CodeIndexAccessDeniedError("Repository is not visible to this Actor");
          }

          const insertedRevision = await transaction.query<RevisionRow>(
            `INSERT INTO code_revisions (
               id, workspace_id, repository_id, commit_oid, source_ref,
               source_digest, tree_oid, tree_digest, file_count,
               discovered_by_user_id, discovered_by_agent_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (repository_id, commit_oid) DO NOTHING
             RETURNING id, source_digest, tree_oid, tree_digest, file_count`,
            [
              crypto.randomUUID(),
              actor.workspaceId,
              repositoryId,
              commitOid,
              sourceRef,
              sourceDigest,
              gitPreparation?.treeOid ?? null,
              treeDigest,
              files.length,
              actor.userId,
              actor.agentId ?? null,
            ],
          );
          const revisionWasInserted = insertedRevision.rows.length === 1;
          let revision = insertedRevision.rows[0];
          if (!revision) {
            const existingRevision = await transaction.query<RevisionRow>(
              `SELECT id, source_digest, tree_oid, tree_digest, file_count
               FROM code_revisions
               WHERE workspace_id = $1
                 AND repository_id = $2
                 AND commit_oid = $3`,
              [actor.workspaceId, repositoryId, commitOid],
            );
            revision = existingRevision.rows[0];
          }
          if (!revision) {
            throw new CodeIndexAccessDeniedError("Revision is not visible to this Actor");
          }
          if (
            revision.source_digest !== sourceDigest ||
            revision.tree_oid !== (gitPreparation?.treeOid ?? null) ||
            revision.tree_digest !== treeDigest
          ) {
            throw new CodeRevisionConflictError(
              "The commit OID is already indexed with different source or Git tree evidence",
            );
          }
          if (revisionWasInserted && gitManifest) {
            await insertGitManifest(transaction, actor, repositoryId, revision.id, gitManifest);
          }

          const generationId = crypto.randomUUID();
          const insertedGeneration = await transaction.query<GenerationRow>(
            `INSERT INTO code_index_generations (
               id, workspace_id, repository_id, revision_id, indexer_revision,
               status, artifact_count, indexed_by_user_id, indexed_by_agent_id,
               ready_at
             ) VALUES ($1, $2, $3, $4, $5, 'ready', $6, $7, $8, now())
             ON CONFLICT (revision_id, indexer_revision) DO NOTHING
             RETURNING id, artifact_count, status`,
            [
              generationId,
              actor.workspaceId,
              repositoryId,
              revision.id,
              CODE_INDEX_REVISION,
              artifacts.length,
              actor.userId,
              actor.agentId ?? null,
            ],
          );
          const inserted = insertedGeneration.rows[0];
          if (!inserted) {
            const existingGeneration = await transaction.query<GenerationRow>(
              `SELECT id, artifact_count, status
               FROM code_index_generations
               WHERE workspace_id = $1
                 AND repository_id = $2
                 AND revision_id = $3
                 AND indexer_revision = $4`,
              [actor.workspaceId, repositoryId, revision.id, CODE_INDEX_REVISION],
            );
            const generation = existingGeneration.rows[0];
            if (!generation) {
              throw new CodeIndexAccessDeniedError("Index generation is not visible to this Actor");
            }
            if (generation.status !== "active") {
              if (generation.status !== "ready" && generation.status !== "retiring") {
                throw new CodeIndexValidationError(
                  `Index generation cannot be published from ${generation.status}`,
                );
              }
              await transaction.query("SELECT lore.activate_code_index_generation($1)", [
                generation.id,
              ]);
            }
            return {
              revisionId: revision.id,
              generationId: generation.id,
              repositoryId,
              repositoryKey,
              commitOid,
              indexerRevision: CODE_INDEX_REVISION,
              sourceDigest,
              fileCount: revision.file_count,
              artifactCount: generation.artifact_count,
              reused: true,
            };
          }

          await insertArtifactBatch(
            transaction,
            actor,
            repositoryId,
            revision.id,
            generationId,
            artifacts,
            dependencies,
          );
          await insertDependencyEdges(
            transaction,
            actor,
            repositoryId,
            revision.id,
            generationId,
            dependencies,
          );
          await transaction.query("SELECT lore.activate_code_index_generation($1)", [generationId]);
          return {
            revisionId: revision.id,
            generationId,
            repositoryId,
            repositoryKey,
            commitOid,
            indexerRevision: CODE_INDEX_REVISION,
            sourceDigest,
            fileCount: revision.file_count,
            artifactCount: artifacts.length,
            reused: false,
          };
        });
      } catch (error) {
        if (
          error instanceof CodeIndexAccessDeniedError ||
          error instanceof CodeRevisionConflictError ||
          error instanceof CodeIndexValidationError
        ) {
          throw error;
        }
        if (isPostgresAccessDenied(error)) {
          throw new CodeIndexAccessDeniedError("Actor cannot index code in this Workspace", {
            cause: error,
          });
        }
        throw error;
      }
    },

    async indexGitRevision(actor, input) {
      const repositoryKey = validatePlainText(input.repositoryKey, "repositoryKey", 512);
      const commitOid = validateCommitOid(input.commitOid);
      const canonicalPath = await resolveGitCommit(input.repositoryPath, commitOid);
      const treeOid = await resolveGitTreeOid(canonicalPath, commitOid);
      const active = await findActiveGitRevision(actor, repositoryKey, commitOid, treeOid);
      if (active) {
        const manifest = await reader.getGitRevisionManifest(actor, { repositoryKey, commitOid });
        return {
          revisionId: active.id,
          generationId: active.generation_id,
          repositoryId: active.repository_id,
          repositoryKey,
          commitOid,
          indexerRevision: CODE_INDEX_REVISION,
          sourceDigest: active.source_digest,
          fileCount: active.file_count,
          artifactCount: active.artifact_count,
          reused: true,
          manifest,
          parsedFileCount: 0,
          reusedFileCount: manifest.indexedFileCount,
        };
      }
      const snapshot = await readGitRevisionFiles(canonicalPath, commitOid);
      const reusableByPath = await loadReusableGitFiles(
        database,
        actor,
        snapshot.manifest,
        (transaction) => installModuleContext(transaction, actor),
      );
      const parsedByPath = new Map(
        (
          await mapConcurrent(
            snapshot.files.filter((file) => !reusableByPath.has(file.path)),
            CODE_INDEX_LIMITS.parserConcurrency,
            async (file) => ({ prepared: await prepareFile(file), path: file.path }),
          )
        ).map((prepared) => [prepared.path, prepared.prepared] as const),
      );
      const artifacts = snapshot.files.flatMap(
        (file) =>
          reusableByPath.get(file.path)?.artifacts ?? parsedByPath.get(file.path)?.artifacts ?? [],
      );
      const dependencies = snapshot.files.flatMap(
        (file) =>
          parsedByPath.get(file.path)?.dependencies ??
          reusableByPath.get(file.path)?.dependencies ??
          [],
      );
      const revisionInput: IndexCodeRevisionInput = {
        repositoryKey,
        displayName: input.displayName,
        commitOid,
        sourceRef: input.sourceRef,
        files: snapshot.files,
      };
      const preparation: VerifiedGitPreparation = {
        manifest: snapshot.manifest,
        treeOid,
        artifacts,
        dependencies,
        parsedFileCount: parsedByPath.size,
        reusedFileCount: reusableByPath.size,
      };
      verifiedGitPreparations.set(revisionInput, preparation);
      try {
        const indexed = maintenanceLease
          ? await persistGitRevisionResumably(actor, revisionInput, preparation)
          : await module.indexRevision(actor, revisionInput);
        return {
          ...indexed,
          manifest: snapshot.manifest,
          parsedFileCount: preparation.parsedFileCount,
          reusedFileCount: preparation.reusedFileCount,
        };
      } finally {
        verifiedGitPreparations.delete(revisionInput);
      }
    },

    getGitRevisionManifest: reader.getGitRevisionManifest,

    search: reader.search,
  };
  return module;
}

export type CodeIndexMaintenanceStatus = "complete" | "dead" | "idle" | "retry";

export interface CodeIndexMaintenanceResult {
  status: CodeIndexMaintenanceStatus;
  jobId?: string;
  generationId?: string;
  parsedFileCount?: number;
  reusedFileCount?: number;
  retryAfterSeconds?: number;
}

export interface CodeIndexMaintenanceLog {
  event: "job_complete" | "job_dead" | "job_retry";
  jobId: string;
  attempt: number;
}

export interface CodeIndexMaintenanceOptions {
  leaseSeconds?: number;
  logger?: (entry: CodeIndexMaintenanceLog) => void;
}

interface ClaimedCodeIndexJobRow {
  id: string;
  workspace_id: string;
  repository_id: string;
  repository_key: string;
  display_name: string;
  repository_path: string;
  commit_oid: string;
  source_ref: string | null;
  indexer_revision: string;
  requested_by_user_id: string;
  requested_by_agent_id: string | null;
  attempt_count: number;
}

function codeIndexRetryDelay(attempt: number): number {
  return Math.min(3_600, 30 * 2 ** Math.max(0, attempt - 1));
}

export function createCodeIndexMaintenanceModule(
  database: PostgresDatabase,
  options: CodeIndexMaintenanceOptions = {},
) {
  const leaseSeconds = Math.max(30, Math.min(options.leaseSeconds ?? 900, 3_600));
  const logger = options.logger ?? (() => undefined);

  return {
    async run(requestedJobId?: string): Promise<CodeIndexMaintenanceResult> {
      const jobId = requestedJobId ? validateUuid(requestedJobId, "jobId") : null;
      const leaseToken = crypto.randomUUID();
      const claimed = await database.transaction(async (transaction) => {
        const result = await transaction.query<ClaimedCodeIndexJobRow>(
          "SELECT * FROM lore.claim_code_index_job($1, $2, $3, $4)",
          [jobId, CODE_INDEX_REVISION, leaseToken, leaseSeconds],
        );
        return result.rows[0] ?? null;
      });
      if (!claimed) return { status: "idle" };
      if (claimed.indexer_revision !== CODE_INDEX_REVISION) {
        throw new Error("Claimed Code Index job has an incompatible indexer revision");
      }
      const actor: ActorContext = {
        workspaceId: claimed.workspace_id,
        userId: claimed.requested_by_user_id,
        ...(claimed.requested_by_agent_id ? { agentId: claimed.requested_by_agent_id } : {}),
      };
      const code = createCodeIndexModule(database, {
        maintenanceLease: {
          jobId: claimed.id,
          leaseToken,
          repositoryId: claimed.repository_id,
        },
      });
      try {
        const indexed = await code.indexGitRevision(actor, {
          repositoryKey: claimed.repository_key,
          displayName: claimed.display_name,
          repositoryPath: claimed.repository_path,
          commitOid: claimed.commit_oid,
          ...(claimed.source_ref ? { sourceRef: claimed.source_ref } : {}),
        });
        const completed = await database.transaction(async (transaction) => {
          const result = await transaction.query<{ status: CodeIndexJobStatus | null }>(
            "SELECT lore.complete_code_index_job($1, $2, $3) AS status",
            [claimed.id, leaseToken, indexed.generationId],
          );
          return result.rows[0]?.status ?? null;
        });
        if (completed !== "succeeded") {
          throw new Error("Code Index job lease was lost before completion");
        }
        logger({ event: "job_complete", jobId: claimed.id, attempt: claimed.attempt_count });
        return {
          status: "complete",
          jobId: claimed.id,
          generationId: indexed.generationId,
          parsedFileCount: indexed.parsedFileCount,
          reusedFileCount: indexed.reusedFileCount,
        };
      } catch {
        const delay = codeIndexRetryDelay(claimed.attempt_count);
        const failed = await database.transaction(async (transaction) => {
          const result = await transaction.query<{ status: CodeIndexJobStatus | null }>(
            "SELECT lore.finish_code_index_job($1, $2, $3, $4) AS status",
            [claimed.id, leaseToken, "Code Index processing failed", delay],
          );
          return result.rows[0]?.status ?? null;
        });
        if (!failed) throw new Error("Code Index job lease was lost before failure completion");
        if (failed === "dead") {
          logger({ event: "job_dead", jobId: claimed.id, attempt: claimed.attempt_count });
          return { status: "dead", jobId: claimed.id };
        }
        logger({ event: "job_retry", jobId: claimed.id, attempt: claimed.attempt_count });
        return { status: "retry", jobId: claimed.id, retryAfterSeconds: delay };
      }
    },
  };
}
