import { readBoundedResponseText } from "../provider-response";

export interface RemoteEmbeddingRequestOptions {
  fetch?: typeof fetch;
  maxRetries?: number;
  random?: () => number;
  retryBaseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : fallback;
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function postEmbeddingJson(input: {
  body: unknown;
  headers: Record<string, string>;
  service: string;
  url: string;
  options: RemoteEmbeddingRequestOptions;
}): Promise<Response> {
  const fetchImplementation = input.options.fetch ?? fetch;
  const maxRetries = boundedInteger(input.options.maxRetries, 2, 5);
  const retryBaseDelayMs = boundedInteger(input.options.retryBaseDelayMs, 250, 10_000);
  const timeoutMs = Math.max(
    1_000,
    Math.min(boundedInteger(input.options.timeoutMs, 120_000, 600_000), 600_000),
  );
  const random = input.options.random ?? Math.random;
  const sleep = input.options.sleep ?? defaultSleep;
  let response: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      response = await fetchImplementation(input.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...input.headers,
        },
        body: JSON.stringify(input.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt === maxRetries) throw error;
      response = undefined;
    }
    if (response?.ok) return response;
    if (response && (!retryable(response.status) || attempt === maxRetries)) {
      const detail = (await readBoundedResponseText(response).catch(() => ""))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      throw new Error(
        `${input.service} embedding request failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    if (response) await readBoundedResponseText(response).catch(() => undefined);
    const exponentialDelay = retryBaseDelayMs * 2 ** attempt;
    await sleep(Math.round(exponentialDelay * (0.5 + random())));
  }

  throw new Error(`${input.service} embedding request failed without a response`);
}
