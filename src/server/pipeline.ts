// Write-path helpers: deterministic chunking, zero-LLM wikilink extraction,
// and the embeddings client. No DB access here — pure functions plus one fetch.

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

// Paragraph-accumulating splitter targeting ~1200 chars (≈400 tokens). Memories
// are usually a single chunk; oversized paragraphs get hard-split.
export function chunkBody(body: string, target = 1200): string[] {
  const paras = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > target) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > target * 2) {
      out.push(cur.slice(0, target));
      cur = cur.slice(target);
    }
  }
  if (cur) out.push(cur);
  return out;
}

// [[target]], [[target#section]], [[target|label]] — fenced code stripped first
// so examples don't become edges. Returns de-duped refs (slug or title).
export function extractWikilinks(body: string): string[] {
  const noFences = body.replace(/```[\s\S]*?```/g, "");
  const refs = new Set<string>();
  for (const m of noFences.matchAll(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) {
    const ref = m[1].trim();
    if (ref) refs.add(ref);
  }
  return [...refs];
}

export interface EmbeddingsConfig {
  url: string;
  apiKey: string;
  model: string;
  dim: number;
}

export function embeddingsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingsConfig {
  return {
    url: env.EMBEDDINGS_URL ?? "",
    apiKey: env.EMBEDDINGS_API_KEY ?? "",
    model: env.EMBEDDINGS_MODEL ?? "unconfigured",
    dim: Number(env.EMBEDDINGS_DIM ?? 1536),
  };
}

// OpenAI-compatible /embeddings client. Fails loud on misconfig — a write that
// can't embed must not half-land (the store only writes after embedding).
export function makeEmbedFn(cfg: EmbeddingsConfig): EmbedFn {
  return async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];
    if (!cfg.url || !cfg.apiKey) {
      throw new Error(
        "embeddings not configured: set EMBEDDINGS_URL, EMBEDDINGS_API_KEY, EMBEDDINGS_MODEL, EMBEDDINGS_DIM",
      );
    }
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: cfg.model, input: texts, dimensions: cfg.dim }),
    });
    if (!res.ok) throw new Error(`embeddings ${res.status}`);
    const json = (await res.json()) as { data?: { index?: number; embedding: number[] }[] };
    const data = json.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error("embeddings response shape mismatch");
    }
    // Providers may reorder; index is authoritative when present.
    const out: number[][] = new Array(texts.length);
    data.forEach((d, i) => {
      out[d.index ?? i] = d.embedding;
    });
    for (const v of out) {
      if (!Array.isArray(v) || v.length !== cfg.dim) {
        throw new Error(`embeddings dim mismatch: got ${v?.length}, expected ${cfg.dim}`);
      }
    }
    return out;
  };
}
