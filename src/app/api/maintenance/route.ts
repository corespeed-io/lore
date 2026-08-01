import { grantFor } from "@/server/auth-bearer";
// The one background job this brain has: deterministic mention linking into the
// 'auto' edge lane. Nothing calls it on its own — wire whatever scheduler your
// host has (a Workers Cron Trigger hitting this URL, a Railway cron, a laptop
// crontab), and it is off until you do.
//
// An HTTP route rather than a Workers `scheduled` handler on purpose: OpenNext's
// generated worker exports only `fetch` plus its Durable Object classes, so
// adding `scheduled` would mean hand-maintaining a wrapper across OpenNext
// upgrades — and a Cron Trigger invocation caps at 15 minutes wall-clock while
// an HTTP-triggered Worker does not (CPU is capped either way).
//
// POST /api/maintenance
//      {}                          -> mention sweep (the default job)
//      { "limit": 50 }             -> batch size (default 50, max 200)
//      { "dryRun": true }          -> report the edges it WOULD add, write none
//      { "action": "clear" }       -> delete every auto edge and rescan later
//      { "action": "memory" }      -> summarize, extract, project, consolidate
//      { "action": "health" }      -> backend health counters (no writes)
//
// The memory job is where background extraction belongs: extraction is
// deliberately NOT run synchronously after every message, so a scheduler drives
// it and the lease keeps exactly one writer at a time.
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Long enough that a slow batch cannot be double-run, short enough that a
// crashed run frees up on its own.
const LEASE_MINUTES = 10;

export async function POST(req: Request) {
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

  const body = (await req.json().catch(() => ({}))) as {
    limit?: number;
    dryRun?: boolean;
    action?: string;
    thread_id?: string;
  };

  const { getStore, getDb } = await import("@/server/local");
  const store = await getStore();

  if (body.action === "clear") {
    return NextResponse.json({ action: "clear", ...(await store.clearAutoEdges()) });
  }

  const db0 = await getDb();
  if (body.action === "health") {
    // Read-only, so it does not take the lease.
    const { memoryHealth } = await import("@/server/memory/consolidate");
    return NextResponse.json({ action: "health", ...(await memoryHealth(db0)) });
  }

  // Compare-and-set: whoever wins the UPDATE holds the lease, everyone else
  // gets a 409 and leaves. No row updated means someone is already sweeping.
  const db = await getDb();
  const lease = await db.query(
    `UPDATE meta SET maintenance_lease = now()
     WHERE id = 1 AND (maintenance_lease IS NULL
                       OR maintenance_lease < now() - make_interval(mins => $1))
     RETURNING 1`,
    [LEASE_MINUTES],
  );
  if (lease.rows.length === 0) {
    return NextResponse.json({ detail: "a sweep is already running" }, { status: 409 });
  }
  try {
    if (body.action === "memory") {
      const { runMemoryMaintenance } = await import("@/server/memory/maintenance");
      return NextResponse.json({
        action: "memory",
        ...(await runMemoryMaintenance(db, store, { limit: body.limit, threadId: body.thread_id })),
      });
    }
    const result = await store.sweepMentions({ limit: body.limit, dryRun: body.dryRun });
    return NextResponse.json({
      ...result,
      // Keep the response small: the pair list is for eyeballing a dry run.
      pairs: body.dryRun ? result.pairs.slice(0, 200) : undefined,
    });
  } finally {
    // Release immediately so the next batch can start; the timeout is only a
    // backstop for a crashed run.
    await db.query("UPDATE meta SET maintenance_lease = NULL WHERE id = 1").catch(() => {});
  }
}
