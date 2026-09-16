import { Ollama } from "ollama/browser";

export async function endpointIsHealthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

export async function readOllamaModels(ollamaUrl) {
  try {
    const client = new Ollama({
      host: ollamaUrl,
    });
    return await client.list();
  } catch (error) {
    if (error instanceof Error && typeof error.status_code === "number") {
      throw new Error(`Ollama health check failed with HTTP ${error.status_code}`);
    }
    throw new Error(`Ollama is unavailable at ${ollamaUrl}. Start Ollama before Lore.`);
  }
}
