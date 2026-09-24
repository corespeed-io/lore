import { createHash } from "node:crypto";
import { CodeIndexValidationError } from "./errors";
import { CODE_INDEX_LIMITS } from "./protocol";
import type { CodeSourceFile, GitRevisionManifest } from "./types";

/** The 400-class error a calling module reports; each Code/context module keeps its own. */
export type ValidationErrorClass = new (message: string) => Error;

/** Tab, line feed, and carriage return: the only C0 controls a free-text query may carry. */
const QUERY_WHITESPACE_CODE_POINTS: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d]);

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hasControlCharacters(value: string, allowQueryWhitespace = false): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (allowQueryWhitespace && QUERY_WHITESPACE_CODE_POINTS.has(codePoint)) return false;
    return codePoint <= 31 || codePoint === 127;
  });
}

export function validateCommitOid(
  commitOid: string,
  ErrorClass: ValidationErrorClass = CodeIndexValidationError,
): string {
  const normalized = commitOid.trim().toLowerCase();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(normalized)) {
    throw new ErrorClass("commitOid must be a full 40- or 64-character Git OID");
  }
  return normalized;
}

/** A lowercase RFC 9562 UUID, the same form request Workspace headers must carry. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function validateUuid(
  value: string,
  name: string,
  ErrorClass: ValidationErrorClass = CodeIndexValidationError,
): string {
  const normalized = value.trim().toLowerCase();
  if (!isUuid(normalized)) throw new ErrorClass(`${name} must be a UUID`);
  return normalized;
}

/** An identifier-like value (key, name, ref): trimmed, bounded, and free of every C0 control. */
export function validatePlainText(
  value: string,
  name: string,
  maximumLength: number,
  ErrorClass: ValidationErrorClass = CodeIndexValidationError,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || hasControlCharacters(normalized)) {
    throw new ErrorClass(`${name} is invalid`);
  }
  return normalized;
}

/** The longest operator-configured Code Repository key any surface accepts. */
export const REPOSITORY_KEY_MAXIMUM_LENGTH = 512;

/** An operator-configured Code Repository key, bounded like every other surface. */
export function validateRepositoryKey(
  value: string,
  ErrorClass: ValidationErrorClass = CodeIndexValidationError,
): string {
  return validatePlainText(value, "repositoryKey", REPOSITORY_KEY_MAXIMUM_LENGTH, ErrorClass);
}

/**
 * A free-text retrieval query: like plain text, but multi-line queries and pasted code keep
 * their tabs and line breaks, as Memory search already accepts. NUL and the other C0
 * controls stay rejected.
 */
export function validateQueryText(
  value: string,
  name: string,
  maximumLength: number,
  ErrorClass: ValidationErrorClass = CodeIndexValidationError,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || hasControlCharacters(normalized, true)) {
    throw new ErrorClass(`${name} is invalid`);
  }
  return normalized;
}

export function validatePath(path: string): string {
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

export function validateAndSortFiles(files: readonly CodeSourceFile[]): CodeSourceFile[] {
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

export function digestFiles(files: readonly CodeSourceFile[]): string {
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

export function digestGitManifest(manifest: GitRevisionManifest): string {
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

export async function mapConcurrent<Input, Result>(
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
