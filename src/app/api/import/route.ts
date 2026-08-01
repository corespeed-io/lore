import { isMemorySlug } from "@/server/memory/projection";
import { type VaultFile, isMarkdown, parseNote } from "@/server/vault";
// Vault import: the browser reads the folder and posts batches here. Nothing
// server-side touches a filesystem, so this behaves identically on a Node host
// and on Workers.
//
// Auth is the SAME write bearer /api/mcp uses. The viewer console stays
// read-only by construction: writing needs the write credential, whoever you
// are and however you got past the viewer gate.
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// One batch is bounded so a single request cannot outrun a Worker's CPU budget;
// the client sends as many batches as the vault needs.
const MAX_FILES = 25;
const MAX_BYTES = 2_000_000;

interface FileResult {
  path: string;
  slug?: string;
  status: "created" | "unchanged" | "skipped" | "failed";
  pending?: string[];
  detail?: string;
}

export async function POST(req: Request) {
  const { grantFor } = await import("@/server/auth-bearer");
  if (grantFor(req.headers.get("authorization")) !== "write") {
    return NextResponse.json(
      { detail: "write token required" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }
  const { resolveDatabaseUrl } = await import("@/server/drivers");
  if (!(await resolveDatabaseUrl())) {
    return NextResponse.json({ detail: "standalone brain not configured" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "bad request" }, { status: 400 });
  }
  const files = (body as { files?: unknown })?.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
    return NextResponse.json({ detail: `files must be 1..${MAX_FILES} entries` }, { status: 400 });
  }

  const { getStore } = await import("@/server/local");
  const store = await getStore();
  const results: FileResult[] = [];
  for (const raw of files) {
    const file = raw as Partial<VaultFile>;
    if (typeof file.path !== "string" || typeof file.text !== "string") {
      results.push({ path: String(file.path ?? "?"), status: "failed", detail: "bad entry" });
      continue;
    }
    if (!isMarkdown(file.path)) {
      results.push({ path: file.path, status: "skipped", detail: "not markdown" });
      continue;
    }
    if (file.text.length > MAX_BYTES) {
      results.push({ path: file.path, status: "skipped", detail: "too large" });
      continue;
    }
    const note = parseNote({ path: file.path, text: file.text });
    if (!note.slug) {
      results.push({ path: file.path, status: "failed", detail: "path yields an empty slug" });
      continue;
    }
    // A vault that happens to contain a `memory/` folder must not be able to
    // write into the generated-projection namespace: a later rebuild would
    // clobber the user's note, or the note would shadow a real memory. put_page
    // enforces the same rule; the importer is the other way in.
    if (isMemorySlug(note.slug)) {
      results.push({
        path: file.path,
        slug: note.slug,
        status: "skipped",
        detail: "the memory/ namespace is reserved for generated memory projections",
      });
      continue;
    }
    try {
      const res = await store.putPage({
        slug: note.slug,
        title: note.title,
        body: note.body,
        frontmatter: note.frontmatter,
      });
      results.push({
        path: file.path,
        slug: res.slug,
        status: res.unchanged ? "unchanged" : "created",
        pending: res.pending,
      });
    } catch (e) {
      results.push({
        path: file.path,
        status: "failed",
        detail: e instanceof Error ? e.message : "write failed",
      });
    }
  }
  return NextResponse.json({ results });
}
