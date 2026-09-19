import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { CodeIndexValidationError } from "./errors";
import { CODE_INDEX_LIMITS } from "./protocol";
import type {
  CodeSourceFile,
  GitRevisionManifest,
  GitRevisionManifestEntry,
  GitTreeEntryExclusionReason,
} from "./types";
import { sha256, validateAndSortFiles, validatePath, validatePlainText } from "./validation";

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

export async function readGitRevisionFiles(
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

export async function resolveGitTreeOid(canonicalPath: string, commitOid: string): Promise<string> {
  const treeOid = (await gitOutput(canonicalPath, ["rev-parse", "--verify", `${commitOid}^{tree}`]))
    .toString("utf8")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(treeOid)) {
    throw new CodeIndexValidationError("Git commit resolved to an invalid tree OID");
  }
  return treeOid;
}

export async function resolveGitCommit(repositoryPath: string, commitOid: string): Promise<string> {
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
