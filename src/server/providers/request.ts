const MAX_PROVIDER_ERROR_RESPONSE_BYTES = 4 * 1024;
const MAX_PROVIDER_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
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

export interface ProviderRequestOptions extends RequestInit {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  errorMessage: (status: number) => string;
}

// Callers own protocol payloads, deadlines, and retry policy. This transport owns
// HTTP failure handling and bounded body consumption without exposing provider bodies.
export async function requestProviderJson<Result>(
  url: string | URL,
  options: ProviderRequestOptions,
): Promise<Result> {
  const { fetch: fetchImplementation = globalThis.fetch, errorMessage, ...init } = options;
  const response = await fetchImplementation(url, init);
  if (!response.ok) {
    await readBoundedResponseText(response, MAX_PROVIDER_ERROR_RESPONSE_BYTES).catch(
      () => undefined,
    );
    throw new Error(errorMessage(response.status));
  }
  const text = await readBoundedResponseText(response, MAX_PROVIDER_JSON_RESPONSE_BYTES);
  try {
    return JSON.parse(text) as Result;
  } catch {
    throw new Error("Provider returned invalid JSON");
  }
}
