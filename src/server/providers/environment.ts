/**
 * Shared parsing for the deployment environment every provider factory reads,
 * plus the one base-URL transport rule every adapter applies.
 */

/**
 * Hosts a provider base URL may reach over plain HTTP. Loopback never leaves the
 * machine, and `host.docker.internal` is the Compose `host-gateway` bridge to
 * the Docker host (compose.yaml maps it for both Lore containers and documents
 * it for local Ollama and rerankers), so it does not leave the machine either.
 */
export const PLAINTEXT_PROVIDER_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
  "host.docker.internal",
]);

/**
 * Parse a provider base URL. It must be http or https, and HTTPS outside
 * {@link PLAINTEXT_PROVIDER_HOSTS} unless the caller opts out, which only a
 * self-hosted surface that is sent no credential may do. `subject` names the
 * setting in errors, which never echo the URL because an operator may have
 * embedded credentials in it.
 */
export function providerBaseUrl(
  value: string,
  subject: string,
  { requireHttps = true }: { requireHttps?: boolean } = {},
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${subject} must be an absolute http or https URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${subject} must use http or https`);
  }
  if (requireHttps && url.protocol !== "https:" && !PLAINTEXT_PROVIDER_HOSTS.has(url.hostname)) {
    throw new Error(`${subject} must use https outside loopback or host.docker.internal`);
  }
  return url;
}

/** A configured value, or `undefined` when the variable is unset or blank. */
export function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** A positive integer setting, falling back when the value is absent or invalid. */
export function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Ollama's keep-alive: seconds as a number, or one of its duration strings such
 * as `5m`. An unset or empty value unloads the model after each request.
 */
export function keepAlive(value: string | undefined): string | number {
  if (value === undefined || value === "") return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}
