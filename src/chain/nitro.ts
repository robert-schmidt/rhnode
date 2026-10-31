// Our own node's sync state, per process: its head against the sequencer's (the official RPC), every 10 s. Upstream
// endpoints on host `nitro` are used only while it's within SYNCED_BLOCKS of it, so a node that's catching up (from a
// snapshot, or after a restart) is never asked and the public endpoints answer instead. The switch both ways is automatic.
import { PUBLIC_RPC } from "./constants.ts";

export const SYNCED_BLOCKS = 50;
export const nitro = { url: "", head: null as number | null, behind: null as number | null, since: 0 };
export const nitroSynced = () => nitro.since > 0;

async function headOf(url: string): Promise<number> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}', signal: AbortSignal.timeout(3_000) });
  return Number(((await r.json()) as { result: string }).result);
}

async function probe() {
  const [n, ref] = await Promise.allSettled([headOf(nitro.url), headOf(PUBLIC_RPC)]);
  if (n.status === "rejected") nitro.head = nitro.behind = null;
  else {
    nitro.head = n.value;
    // The reference failing says nothing about our node: keep the last verdict, so one slow public probe doesn't
    // reset `since` (clients gate on it staying unbroken). A stuck node shows on the next answered probe.
    if (ref.status === "fulfilled") nitro.behind = Math.max(0, ref.value - n.value);
    else if (nitro.behind == null) return;
  }
  const synced = nitro.behind != null && nitro.behind <= SYNCED_BLOCKS;
  if (!synced && nitro.since) { nitro.since = 0; console.warn(`[nitro] not synced (${nitro.behind ?? "no answer"} behind): public endpoints answer`); }
  else if (synced && !nitro.since) { nitro.since = Date.now(); console.log(`[nitro] synced (${nitro.behind} behind): using it`); }
}

/** Start probing (once per process). */
export function watchNitro(url: string): void {
  if (nitro.url) return;
  nitro.url = url;
  void probe();
  setInterval(probe, 10_000).unref();
}
export const isNitro = (url: string) => /^https?:\/\/nitro[:/]/.test(url);
