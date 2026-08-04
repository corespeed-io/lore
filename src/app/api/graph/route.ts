import { createHash } from "node:crypto";
import { buildGraph } from "@/lib/graph";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    // ETag over the serialized graph: the server already caches the build for
    // an hour, but every page load re-downloaded the same ~240 KB body. With a
    // validator the browser's own cache answers repeat loads with a 304 and no
    // body at all. Hashing costs well under a millisecond next to a build that
    // costs seconds; `private` because the console sits behind auth and a
    // shared cache must not serve one viewer's graph to another. no-cache
    // means "revalidate every time", NOT "don't cache" — every request still
    // hits this route and sees a fresh graph the moment the server cache
    // turns over, so nothing about freshness changes, only the bytes.
    const body = JSON.stringify(await buildGraph());
    const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { etag, "cache-control": "private, no-cache" },
      });
    }
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        etag,
        "cache-control": "private, no-cache",
      },
    });
  } catch (err) {
    // The thrown reason (which reads failed, how many) only exists server-side;
    // without this line the 502 is an opaque "couldn't reach the brain".
    console.error("graph build failed:", err);
    return NextResponse.json({ detail: "couldn't reach the brain" }, { status: 502 });
  }
}
