import { providerHttpError, readBoundedResponseJson } from "./provider-response";

interface ProviderRequestOptions extends RequestInit {
  fetch?: typeof globalThis.fetch;
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
  if (!response.ok) throw await providerHttpError(response, errorMessage(response.status));
  return readBoundedResponseJson<Result>(response);
}
