/**
 * Vercel AI Gateway reaches many upstream models with one deployment credential
 * (`AI_GATEWAY_API_KEY`), over the two contracts it actually serves: an
 * OpenAI-compatible surface under `/v1` for embeddings and chat completions,
 * and the Cohere Rerank contract at the bare host. Adapters bind one of these
 * two and share the model-id rule below.
 */
export const VERCEL_AI_GATEWAY_HOST = "https://ai-gateway.vercel.sh";

export const VERCEL_AI_GATEWAY_OPENAI_BASE_URL = `${VERCEL_AI_GATEWAY_HOST}/v1`;

/**
 * Every gateway model is a `creator/model` slug. A bare vendor id must fail
 * while the provider is being constructed, not as an upstream 404 on the first
 * Memory write or benchmark question.
 */
export function assertVercelAIGatewayModel(model: string, example: string): void {
  if (!/^[^\s/]+\/\S+$/u.test(model)) {
    throw new Error(`Vercel AI Gateway models are creator/model ids such as ${example}`);
  }
}
