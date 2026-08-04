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
//      { "action": "semantic" }    -> link pages that are ABOUT the same thing
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
    floor?: number;
    perPage?: number;
  };

  // The same credential screen the MCP dispatcher runs, over this body. This
  // route is a WRITE door that does not pass through handleRpc, and `thread_id`
  // is a caller-supplied string that reaches ensureThread — which is exactly how
  // a credential got into the append-only log once before, hiding in a field
  // nobody had listed. The rule follows the doors, not the tool registry: any
  // door that writes runs the screen, and it does it by CALLING the same
  // function rather than growing a copy of the decision.
  const { findSecretsInPayload } = await import("@/server/memory/safety");
  const found = findSecretsInPayload(body);
  if (found.length) {
    return NextResponse.json(
      {
        detail: `refused: request contains ${found.map((f) => f.kind).join(", ")} — credentials are never accepted as input`,
      },
      { status: 400 },
    );
  }

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
  //
  // The winner keeps the exact timestamp it wrote as a FENCING TOKEN, because
  // acquiring was compare-and-set while releasing was not: the release cleared
  // the column unconditionally. So a holder that overran the timeout — the only
  // situation the timeout exists for — came back and wiped the lease of the
  // SUCCESSOR that had legitimately taken over, and the next scheduler acquired
  // on top of a sweep already in flight. "Two schedulers cannot sweep at once"
  // was false for exactly the case the lease is there to handle, and it cascades:
  // every overrun hands out one more concurrent sweep.
  const db = await getDb();
  const lease = await db.query(
    `UPDATE meta SET maintenance_lease = now()
     WHERE id = 1 AND (maintenance_lease IS NULL
                       OR maintenance_lease < now() - make_interval(mins => $1))
     RETURNING maintenance_lease::text`,
    [LEASE_MINUTES],
  );
  if (lease.rows.length === 0) {
    return NextResponse.json({ detail: "a sweep is already running" }, { status: 409 });
  }
  // ::text, and compared back as ::timestamptz. The token was the timestamptz
  // itself, and `pg` parses that into a JS Date — MILLISECONDS — while a real
  // server's now() is microsecond-resolution. So the value sent back in the
  // release bore no relation to the value stored, `WHERE maintenance_lease = $1`
  // matched nothing ~999 times in 1000, and the row count was never checked and
  // the error swallowed. The lease was then freed only by the 10-minute timeout:
  // maintenance throttled to one batch per ten minutes, on every deployment
  // target, and a STRICT REGRESSION, because the unconditional release it
  // replaced always worked.
  //
  // CI could not see it. PGlite's now() comes from Date.now(), so its microsecond
  // field is always zero and the round trip is lossless there — the mirror
  // assertion passed for a reason that does not exist in production, which is
  // exactly the class of test failure this branch keeps having to kill. The test
  // now plants a microsecond-bearing lease explicitly rather than trusting now().
  const held = String(lease.rows[0].maintenance_lease);
  try {
    if (body.action === "semantic") {
      // Under the SAME lease as the mention sweep: both write the auto lane, and
      // two writers inferring edges at once is the thing the lease exists for.
      const { runSemanticSweep } = await import("@/server/semantic");
      const result = await runSemanticSweep(db, {
        limit: body.limit,
        floor: body.floor,
        perPage: body.perPage,
        dryRun: body.dryRun,
      });
      return NextResponse.json({
        action: "semantic",
        ...result,
        pairs: body.dryRun ? result.pairs : undefined,
      });
    }
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
    // backstop for a crashed run. Guarded by the token: a holder that has already
    // been superseded releases NOTHING, so it cannot free a lease it no longer
    // owns. If it does not match, the successor is mid-sweep and its lease stands.
    await db
      .query(
        "UPDATE meta SET maintenance_lease = NULL WHERE id = 1 AND maintenance_lease = $1::timestamptz",
        [held],
      )
      .catch(() => {});
  }
}
