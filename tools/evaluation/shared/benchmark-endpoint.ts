import { providerBaseUrl } from "../../../src/server/providers/environment";

/**
 * Validate a benchmark reader/judge base URL with the provider adapters' rule: a
 * request that carries an API key must use HTTPS unless it stays on this machine
 * (or the Compose host bridge), so a self-hosted or overridden endpoint can never
 * receive a credential in plaintext over the network.
 */
export function benchmarkEndpoint(baseUrl: string, label: string, apiKey?: string): string {
  const url = providerBaseUrl(baseUrl, `${label} base URL`, {
    requireHttps: Boolean(apiKey?.trim()),
  });
  return `${url.toString().replace(/\/$/, "")}/`;
}
