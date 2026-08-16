import { chunkMemoryContent, MemoryChunkingError } from "./memory-chunking";

export const MEMORY_CONTENT_LIMITS = {
  recommendedCharacters: 8_000,
  maximumCharacters: 32_000,
  maximumChunks: 64,
} as const;

export class MemoryContentValidationError extends TypeError {
  override name = "MemoryContentValidationError";
  readonly status = 400;
}

export interface PreparedMemoryContent {
  content: string;
  chunks: readonly string[];
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

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
  return { content, chunks };
}
