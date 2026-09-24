const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Validate a benchmark reader/judge base URL. A request that carries an API key
 * must use HTTPS unless it stays on this machine, so a self-hosted or overridden
 * endpoint can never receive a credential in plaintext over the network.
 */
export function benchmarkEndpoint(baseUrl: string, label: string, apiKey?: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} base URL must use http or https`);
  }
  if (apiKey?.trim() && url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${label} base URL must use https outside loopback when it sends an API key`);
  }
  return `${url.toString().replace(/\/$/, "")}/`;
}
