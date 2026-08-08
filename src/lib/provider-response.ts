export const MAX_PROVIDER_ERROR_RESPONSE_BYTES = 4 * 1024;
export const MAX_PROVIDER_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function readBoundedResponseText(
  response: Response,
  maximumBytes = MAX_PROVIDER_ERROR_RESPONSE_BYTES,
): Promise<string> {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Provider response byte limit must be a positive integer");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await cancelBody(response);
    throw new Error(`Provider response exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Provider response exceeds ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readBoundedResponseJson<Result>(
  response: Response,
  maximumBytes = MAX_PROVIDER_JSON_RESPONSE_BYTES,
): Promise<Result> {
  const text = await readBoundedResponseText(response, maximumBytes);
  try {
    return JSON.parse(text) as Result;
  } catch {
    throw new Error("Provider returned invalid JSON");
  }
}
