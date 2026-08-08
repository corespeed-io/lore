export function chunkMemoryContent(content: string, maximumLength = 1_200): string[] {
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
