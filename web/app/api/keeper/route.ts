import { after } from "next/server";
import { runKeeper } from "@/lib/keeper-server";
import { rememberOidc } from "@/lib/gcs-store";
import { beat } from "@/lib/server-heartbeat";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET or POST /api/keeper: run due plans and fill fair cash orders.
 *
 * Open to anyone, because everything it does is permissionless on chain anyway:
 * running a due plan or filling an order at the auction's own price. A short
 * in-memory gap stops one visitor from spinning it in a loop.
 *
 * The scheduler calls this every minute, so it also keeps the trade tape warm:
 * after answering, it asks /api/tape once, and a visitor's first look at the tape
 * never waits on a cold read.
 */
let lastRun = 0;
let running: Promise<unknown> | null = null;

async function handle(request: Request) {
  rememberOidc(request);
  const origin = new URL(request.url).origin;
  after(() => fetch(`${origin}/api/tape`, { cache: "no-store", signal: AbortSignal.timeout(20_000) }).then(() => undefined, () => undefined));
  // A repeat is answered with a 200, not an error, so a scheduler never sees a failure.
  if (running) return Response.json({ busy: true }, { headers: { "cache-control": "no-store" } });
  if (Date.now() - lastRun < 4_000) return Response.json({ throttled: true }, { headers: { "cache-control": "no-store" } });
  lastRun = Date.now();
  running = runKeeper();
  try {
    const report = await running;
    await beat("keeper", report);
    return Response.json(report, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  } finally {
    running = null;
  }
}

export const GET = handle;
export const POST = handle;
