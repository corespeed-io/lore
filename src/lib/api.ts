import { recordRequest } from "./request-log";

// Shared client-side helper to invoke a gbrain read-only tool via /api/call.
// The server route enforces the allowlist; this just unwraps the response.
// Every call is timed and recorded into the session request log (observability).
export async function apiCall(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const startedAt = Date.now();
  try {
    const r = await fetch("/api/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { detail?: string };
      throw new Error(body.detail ?? String(r.status));
    }
    const { text, isError } = (await r.json()) as { text: string; isError: boolean };
    if (isError) throw new Error(text || "brain error");
    recordRequest({ tool, at: startedAt, latencyMs: Date.now() - startedAt, ok: true });
    // A non-JSON body isn't an error — fall back to the raw text. (Kept inside
    // the success path so a parse miss is never recorded as a failed request.)
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    recordRequest({ tool, at: startedAt, latencyMs: Date.now() - startedAt, ok: false, error });
    throw e;
  }
}
