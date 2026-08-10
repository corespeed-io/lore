// Episode JSON needs envelope space around the 1,000,000-character content
// budget. Individual Memory/query commands apply their narrower decoded limits
// after this transport-level read.
const MAX_STDIN_CHARACTERS = 2_000_000;
// A JavaScript UTF-16 code unit occupies at most three UTF-8 bytes. The extra
// bytes permit a trailing CRLF without weakening the decoded character limit.
const MAX_STDIN_BYTES = MAX_STDIN_CHARACTERS * 3 + 2;

export async function readBoundedUtf8Stdin(
  input: AsyncIterable<Uint8Array | string>,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_STDIN_BYTES) {
      throw new TypeError(`stdin exceeds ${MAX_STDIN_CHARACTERS} characters`);
    }
    chunks.push(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    throw new TypeError("stdin must be valid UTF-8", { cause: error });
  }
}
