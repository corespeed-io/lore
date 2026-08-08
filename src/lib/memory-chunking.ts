const maximumStructuredSegments = 256;
const listItemPattern = /^\s*(?:[-*+]\s+|\d+[.)]\s+)\S/u;

function lengthBoundChunks(content: string, maximumLength: number): string[] {
  const remainingWords = content.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const word of remainingWords) {
    if (current && current.length + word.length + 1 > maximumLength) {
      chunks.push(current);
      current = "";
    }
    if (word.length > maximumLength) {
      if (current) chunks.push(current);
      for (let index = 0; index < word.length; index += maximumLength) {
        chunks.push(word.slice(index, index + maximumLength));
      }
      continue;
    }
    current = current ? `${current} ${word}` : word;
  }
  if (current) chunks.push(current);
  return chunks;
}

function structuredListSegments(content: string): string[] | null {
  const lines = content.trim().split(/\r?\n/u);
  const itemCount = lines.filter((line) => listItemPattern.test(line)).length;
  if (itemCount < 2 || itemCount > maximumStructuredSegments) return null;

  const preamble: string[] = [];
  const items: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (listItemPattern.test(line)) {
      if (current) items.push(current.join("\n"));
      current = [trimmed];
    } else if (current) {
      current.push(trimmed);
    } else {
      preamble.push(trimmed);
    }
  }
  if (current) items.push(current.join("\n"));
  if (preamble.length && items.length) {
    items[0] = `${preamble.join("\n")}\n${items[0]}`;
  }
  return items;
}

export function chunkMemoryContent(content: string, maximumLength = 1_200): string[] {
  const normalized = content.trim();
  if (!normalized) return [];
  const structured = structuredListSegments(normalized);
  return (structured ?? [normalized]).flatMap((segment) =>
    lengthBoundChunks(segment, maximumLength),
  );
}
