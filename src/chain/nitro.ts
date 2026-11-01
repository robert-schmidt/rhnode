// Our own node's sync state, per process: its head against the sequencer's (the official RPC), every 10 s. Upstream
// endpoints on host `nitro` are used only while it's synced, so a node that's catching up (from a snapshot, or after a
// restart) is never asked and the public endpoints answer instead. The switch both ways is automatic: on at the first
// good probe, off only after NITRO_BAD_PROBES bad ones in a row (default 3, so 30 s), since every switch drops /v1/stream
// sockets and pauses the history pass. Bad: no answer, more than NITRO_MAX_BEHIND blocks (50) behind the reference, or a
// head that hasn't moved for 30 s (~290 blocks; caught even while the reference is down). A reference that fails or
// answers an error (the official RPC answers some probes with a 429 body) keeps the last distance: until 2026-11-01 that
// body read as NaN behind and flipped every process to the public endpoints for 10 s, a few times an hour.
import { PUBLIC_RPC } from "./constants.ts";

export const SYNCED_BLOCKS = Number(process.env.NITRO_MAX_BEHIND ?? 50);
const BAD_PROBES = Number(process.env.NITRO_BAD_PROBES ?? 3), STALL_MS = 30_000;
export const nitro = { url: "", head: null as number | null, behind: null as number | null, since: 0, bad: 0, moved: 0 };
export const nitroSynced = () => nitro.since > 0;

async function headOf(url: string): Promise<number> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}', signal: AbortSignal.timeout(3_000) });
  const n = Number(((await r.json()) as { result?: string }).result);
  if (!(n > 0)) throw new Error(`no block number (HTTP ${r.status})`);
  return n;
}

/** One probe's outcome: our node's head (null: no answer) and the reference's (null: no answer). */
export function step(head: number | null, ref: number | null, now: number): void {
  if (head == null) nitro.head = null;
  else {
    if (head !== nitro.head) nitro.moved = now;
    nitro.head = head;
    if (ref != null) nitro.behind = Math.max(0, ref - head);
  }
  const why = nitro.head == null ? "no answer" : nitro.behind == null ? "no reference yet" : nitro.behind > SYNCED_BLOCKS
    ? `${nitro.behind} behind` : now - nitro.moved >= STALL_MS ? `head stuck at ${nitro.head}` : "";
  nitro.bad = why ? nitro.bad + 1 : 0;
  if (!why && !nitro.since) { nitro.since = now; console.log(`[nitro] synced (${nitro.behind} behind): using it`); }
  else if (why && nitro.since && nitro.bad >= BAD_PROBES) { nitro.since = 0; console.warn(`[nitro] not synced (${why}, ${nitro.bad} probes): public endpoints answer`); }
}

async function probe() {
  const [n, ref] = await Promise.allSettled([headOf(nitro.url), headOf(PUBLIC_RPC)]);
  step(n.status === "fulfilled" ? n.value : null, ref.status === "fulfilled" ? ref.value : null, Date.now());
}

/** Start probing (once per process). */
export function watchNitro(url: string): void {
  if (nitro.url) return;
  nitro.url = url;
  void probe();
  setInterval(probe, 10_000).unref();
}
export const isNitro = (url: string) => /^https?:\/\/nitro[:/]/.test(url);
