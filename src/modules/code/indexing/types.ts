import type { Lang, SgNode } from "@ast-grep/napi";
import type { ActorContext } from "@/server/auth/actor-context";

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

export interface PreparedArtifact {
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

export interface PreparedDependencyEdge {
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

export interface PreparedModuleBinding {
  kind: PreparedModuleBindingKind;
  localName?: string;
  importedName?: string;
  exportedName?: string;
}

export interface PreparedFileIndex {
  artifacts: PreparedArtifact[];
  dependencies: PreparedDependencyEdge[];
}

export interface ReusableArtifactRow {
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

export interface VerifiedGitPreparation {
  manifest: GitRevisionManifest;
  treeOid: string;
  artifacts: readonly PreparedArtifact[];
  dependencies: readonly PreparedDependencyEdge[];
  parsedFileCount: number;
  reusedFileCount: number;
}

export interface ArtifactSpan {
  start: number;
  end: number;
  anchor: SgNode;
}

export interface LanguageSelection {
  language: string;
  parserLanguage: Lang;
}
