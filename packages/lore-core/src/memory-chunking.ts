export const MEMORY_CHUNKING_REVISION = "lore-memory-chunking-v2";
export const MEMORY_CHUNK_MAXIMUM_CHARACTERS = 1_200;
export const MEMORY_CHUNK_OVERLAP_CHARACTERS = 0;

export class MemoryChunkingError extends TypeError {
  override name = "MemoryChunkingError";
}

const sentenceTerminators = new Set([".", "!", "?", ";", "。", "！", "？", "；"]);
const sentenceClosers = new Set(['"', "'", "’", "”", ")", "]", "}", "》", "」", "』"]);

function isHorizontalWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t";
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value);
}

function consumePreviousLineBreak(points: readonly string[], end: number): number | null {
  if (points[end - 1] === "\n") return points[end - 2] === "\r" ? end - 2 : end - 1;
  if (points[end - 1] === "\r") return end - 1;
  return null;
}

function isParagraphBoundary(points: readonly string[], position: number): boolean {
  const priorLineStart = consumePreviousLineBreak(points, position);
  if (priorLineStart === null) return false;
  let cursor = priorLineStart;
  while (cursor > 0 && isHorizontalWhitespace(points[cursor - 1])) cursor -= 1;
  return consumePreviousLineBreak(points, cursor) !== null;
}

function startsMarkdownBlock(points: readonly string[], position: number): boolean {
  if (position >= points.length) return false;
  if (position > 0 && points[position - 1] !== "\n" && points[position - 1] !== "\r") {
    return false;
  }
  let end = position;
  while (end < points.length && points[end] !== "\n" && points[end] !== "\r") end += 1;
  const line = points.slice(position, Math.min(end, position + 160)).join("");
  return /^[ \t]{0,3}(?:#{1,6}(?:[ \t]+|$)|(?:[-+*]|\d+[.)])[ \t]+|```|~~~|>[ \t]+)/u.test(line);
}

function isSentenceBoundary(points: readonly string[], position: number): boolean {
  if (!isWhitespace(points[position - 1])) return false;
  let cursor = position - 1;
  while (cursor >= 0 && isWhitespace(points[cursor])) cursor -= 1;
  while (cursor >= 0 && sentenceClosers.has(points[cursor])) cursor -= 1;
  return cursor >= 0 && sentenceTerminators.has(points[cursor]);
}

function boundaryPriority(points: readonly string[], position: number): number {
  if (isParagraphBoundary(points, position)) return 6;
  if (startsMarkdownBlock(points, position)) return 5;
  if (isSentenceBoundary(points, position)) return 4;
  if (consumePreviousLineBreak(points, position) !== null) return 3;
  if (isWhitespace(points[position - 1])) return 1;
  return 0;
}

function preferredBoundary(
  points: readonly string[],
  start: number,
  hardEnd: number,
  maximumLength: number,
): number {
  const minimumPreferredLength = Math.max(1, Math.ceil(maximumLength / 2));
  const minimumPosition = Math.min(hardEnd, start + minimumPreferredLength);
  let selected = hardEnd;
  let selectedPriority = 0;
  for (let position = minimumPosition; position <= hardEnd; position += 1) {
    const priority = boundaryPriority(points, position);
    if (priority > selectedPriority || (priority === selectedPriority && priority > 0)) {
      selected = position;
      selectedPriority = priority;
    }
  }
  return selected;
}

export function chunkMemoryContent(
  content: string,
  maximumLength = MEMORY_CHUNK_MAXIMUM_CHARACTERS,
): string[] {
  if (!Number.isInteger(maximumLength) || maximumLength < 1) {
    throw new MemoryChunkingError("Memory chunk maximum length must be a positive integer");
  }
  if (!content) return [];

  const points = Array.from(content);
  const chunks: string[] = [];
  for (let start = 0; start < points.length; ) {
    let hardEnd = Math.min(start + maximumLength, points.length);
    if (hardEnd < points.length && points[hardEnd - 1] === "\r" && points[hardEnd] === "\n") {
      hardEnd -= 1;
    }
    const end =
      hardEnd === points.length
        ? hardEnd
        : preferredBoundary(points, start, hardEnd, maximumLength);
    const chunk = points.slice(start, end).join("");
    if (!chunk.trim()) {
      throw new MemoryChunkingError(
        "Memory content would produce a whitespace-only chunk and cannot be indexed safely",
      );
    }
    chunks.push(chunk);
    start = end;
  }
  return chunks;
}
