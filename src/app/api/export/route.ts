import { grantFor } from "@/server/auth-bearer";
import { type TarEntry, serializeNote, tarStream, withSkipReport } from "@/server/tar";
// Export the whole brain as a tar of `slug.md` files. Import and export ship
// together on purpose: a store you can only put data INTO is not one a person
// should trust with their notes.
//
// Read bearer is enough (BRAIN_READ_TOKEN or the write token), same rule as
// /api/mcp — one request that dumps everything deserves an explicit credential
// rather than riding the viewer session.
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const BATCH = 100;

export async function GET(req: Request) {
  if (!grantFor(req.headers.get("authorization"))) {
    return NextResponse.json(
      { detail: "auth required" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }
  const { resolveDatabaseUrl } = await import("@/server/drivers");
  if (!(await resolveDatabaseUrl())) {
    return NextResponse.json({ detail: "standalone brain not configured" }, { status: 404 });
  }
  const { getStore } = await import("@/server/local");
  const store = await getStore();

  // Cursor-paged by slug so memory stays flat no matter how big the brain is.
  async function* entries(): AsyncGenerator<TarEntry> {
    let after: string | undefined;
    for (;;) {
      const batch = await store.exportBatch({ afterSlug: after, limit: BATCH });
      if (batch.length === 0) return;
      for (const page of batch) {
        yield {
          path: `${page.slug}.md`,
          body: serializeNote(page.title, page.frontmatter, page.body),
        };
      }
      after = batch[batch.length - 1].slug;
      if (batch.length < BATCH) return;
    }
  }

  // A skip means a slug too long to be representable in USTAR, and it is
  // discovered mid-stream — the headers are long gone by then. So the report
  // rides INSIDE the archive as one last entry, which any tar can extract.
  // (This used to advertise `trailer: x-skipped-paths` and then never send a
  // trailer, leaving a skip silently unobservable.)
  const skipped: string[] = [];
  const stream = tarStream(withSkipReport(entries(), skipped), exportMtime(req), (path) =>
    skipped.push(path),
  );
  return new Response(stream, {
    headers: {
      "content-type": "application/x-tar",
      "content-disposition": 'attachment; filename="lore-brain.tar"',
      "cache-control": "no-store",
    },
  });
}

// mtime is only metadata here; a caller can pin it for byte-reproducible
// archives (useful when diffing two exports).
function exportMtime(req: Request): number {
  const at = Number(new URL(req.url).searchParams.get("mtime"));
  return Number.isFinite(at) && at > 0 ? Math.floor(at) : Math.floor(Date.now() / 1000);
}
