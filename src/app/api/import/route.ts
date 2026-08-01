import { type VaultFile, isMarkdown, parseNote } from "@/server/vault";
// Vault import: the browser reads the folder and posts batches here. Nothing
// server-side touches a filesystem, so this behaves identically on a Node host
// and on Workers.
//
// Auth is the SAME write bearer /api/mcp uses. The viewer console stays
// read-only by construction: writing needs the write credential, whoever you
// are and however you got past the viewer gate.
//
// And it is the same DOOR, not just the same token: every file is written by
// calling handleRpc's put_page rather than store.putPage, so import crosses the
// dispatcher's rules — the credential screen and refuseReserved — by USING them
// instead of keeping a copy that can drift out of step with them.
//
// It used to call the store directly and screen nothing, which made it a second
// writer into `pages` that crossed none of those rules: a vault file holding an
// AWS key was created, chunked, embedded and FTS-indexed, and a BRAIN_READ_TOKEN
// holder then read back through get_page and search the very credential the tool
// door had refused. "An owner pushes their own vault" did not save it. There is
// no owner-only credential anywhere in this repo — auth-bearer.ts holds two
// tokens and this route accepts the SAME write grant that authorizes put_page —
// so that was a story about who is probably calling, not a property any code
// here can check. And import writes slug/title/body/frontmatter: exactly the
// columns the principal-less page/FTS/embedding surface publishes to every
// reader.
//
// Refusals are PER FILE, which is what makes this the right trade rather than a
// choice between two bad ones: the rest of the vault still imports, and the one
// file that carries a credential comes back with its path for the user to redact
// or rename.
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

  const { handleRpc } = await import("@/server/mcp");
  const { getBrainCtx } = await import("@/server/local");
  const results: FileResult[] = [];
  for (const raw of files) {
    const file = raw as Partial<VaultFile>;
    // Batch shape and transport limits, all of which can only REFUSE a file and
    // never admit one — so they are pre-flight, not a second reader of any rule
    // the door enforces. Anything that decides whether a write is ALLOWED is
    // below, in the one call.
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
    // The reserved memory/ namespace is NOT checked here any more. It was this
    // route's own isMemorySlug call on its own spelling of the slug; refuseReserved
    // now decides it on the same normalized string the store writes the row from,
    // as one rule with one reader for both doors.
    let rpc: Awaited<ReturnType<typeof handleRpc>>;
    try {
      rpc = await handleRpc(getBrainCtx, "write", "tools/call", {
        name: "put_page",
        arguments: {
          slug: note.slug,
          title: note.title,
          body: note.body,
          frontmatter: note.frontmatter,
        },
      });
    } catch (e) {
      // handleRpc throws only where it must fail closed (a payload too deep for
      // the screens to walk). Per file, so one pathological note cannot take the
      // whole batch down with it.
      results.push({
        path: file.path,
        slug: note.slug,
        status: "failed",
        detail: e instanceof Error ? e.message : "refused",
      });
      continue;
    }
    // Two channels, and neither is read by matching prose:
    //   rpc.error — refused before any handler ran (the credential screen). Its
    //     message names the KIND of the finding and never the value, so handing it
    //     back to the user who sent the file is not a second copy of the secret.
    //   isError — the write did not happen: a reserved slug, an invalid slug, an
    //     embeddings outage. (A reserved slug used to report `skipped` from this
    //     route's own copy of that rule and reports `failed` now; both land in the
    //     same "not imported" list in the UI, with the detail saying which.)
    if (rpc.error) {
      results.push({
        path: file.path,
        slug: note.slug,
        status: "skipped",
        detail: rpc.error.message,
      });
      continue;
    }
    const out = rpc.result as { content: { text: string }[]; isError: boolean };
    if (out.isError) {
      results.push({
        path: file.path,
        slug: note.slug,
        status: "failed",
        detail: out.content[0]?.text ?? "write failed",
      });
      continue;
    }
    const put = JSON.parse(out.content[0].text) as {
      slug: string;
      unchanged: boolean;
      pending: string[];
    };
    results.push({
      path: file.path,
      slug: put.slug,
      status: put.unchanged ? "unchanged" : "created",
      pending: put.pending,
    });
  }
  return NextResponse.json({ results });
}
