// Shared client-side helper to invoke a gbrain read-only tool via /api/call.
// The server route enforces the allowlist; this just unwraps the response.
export async function apiCall(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
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
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
