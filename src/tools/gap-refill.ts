// Refill an ingest gap by hand (src/ingest/refill.ts; the promoter's gap worker does the same unattended every 10 min, but
// never deletes). Here a batch stored exactly twice is deleted and inserted once. DRY=1 (default) only prints.
// `node src/tools/gap-refill.ts FROM TO`
import { cfg } from "../config.ts";
import { upstream } from "../chain/upstream.ts";
import { refill } from "../ingest/refill.ts";

const [from, to] = process.argv.slice(2).map(Number);
const left = await refill(upstream(cfg.upstreamHttp), from, to, { dry: process.env.DRY !== "0", fixDoubles: true });
if (left) console.log(`${left} table(s) held a partial count and were left alone`);
process.exit(0);
