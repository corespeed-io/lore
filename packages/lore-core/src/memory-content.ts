import { chunkMemoryContent, MemoryChunkingError } from "./memory-chunking";
import { hasLoneSurrogate, LoreValidationError } from "./validation";

export const MEMORY_CONTENT_LIMITS = {
  recommendedCharacters: 8_000,
  maximumCharacters: 32_000,
  maximumChunks: 64,
} as const;

export class MemoryContentValidationError extends LoreValidationError {
  override name = "MemoryContentValidationError";

  /** `field` names the content that failed, `content` unless a batch names its record. */
  constructor(message: string, options?: ErrorOptions & { field?: string }) {
    super(options?.field ?? "content", message, options);
  }
}

export interface PreparedMemoryContent {
  readonly content: string;
  readonly chunks: readonly string[];
}

/** Every result prepareMemoryContent returned, so a later write may reuse its chunks. */
const ENGINE_PREPARED = new WeakSet<PreparedMemoryContent>();

export function prepareMemoryContent(content: string): PreparedMemoryContent {
  if (typeof content !== "string" || !content.trim()) {
    throw new MemoryContentValidationError("Memory content is required");
  }
  if (content.includes("\0")) {
    throw new MemoryContentValidationError("Memory content contains an invalid null character");
  }
  if (hasLoneSurrogate(content)) {
    throw new MemoryContentValidationError("Memory content contains invalid Unicode");
  }
  if (Array.from(content).length > MEMORY_CONTENT_LIMITS.maximumCharacters) {
    throw new MemoryContentValidationError(
      `Memory content may contain at most ${MEMORY_CONTENT_LIMITS.maximumCharacters} Unicode characters`,
    );
  }
  let chunks: string[];
  try {
    chunks = chunkMemoryContent(content);
  } catch (error) {
    if (error instanceof MemoryChunkingError) {
      throw new MemoryContentValidationError(error.message, { cause: error });
    }
    throw error;
  }
  if (chunks.length > MEMORY_CONTENT_LIMITS.maximumChunks) {
    throw new MemoryContentValidationError(
      `Memory content may produce at most ${MEMORY_CONTENT_LIMITS.maximumChunks} chunks`,
    );
  }
  const prepared = Object.freeze({ content, chunks: Object.freeze(chunks) });
  ENGINE_PREPARED.add(prepared);
  return prepared;
}

/**
 * The canonical chunks of `content`. A caller that already validated it may pass the
 * prepareMemoryContent result; its chunks are reused only when this engine produced
 * them for exactly this text, and the content is chunked again otherwise.
 */
export function memoryContentChunks(
  content: string,
  prepared?: PreparedMemoryContent,
): readonly string[] {
  if (prepared && ENGINE_PREPARED.has(prepared) && prepared.content === content) {
    return prepared.chunks;
  }
  return prepareMemoryContent(content).chunks;
}
