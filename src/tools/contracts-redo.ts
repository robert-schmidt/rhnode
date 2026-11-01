// One-off for migration 026 (2026-11-01): bring the contracts written before it to its rules. Idempotent.
// 1. contracts created by a factory since tip tracing that never emitted a log: written now (their code read at latest);
// 2. ones first seen by a log that have a creation frame: created = 1, with their deployer, factory and creation block;
// 3. first_of_kind again over the whole table: the first row of each fingerprint (block, address), and only if created.
// `node src/tools/contracts-redo.ts` (in the projector container; reads our node).
import { cfg } from "../config.ts";
import { insert, rows } from "../ch.ts";
import { upstream } from "../chain/upstream.ts";
import { writeContracts } from "../projector/contracts.ts";

const up = upstream(cfg.upstreamHttp);
const CREATED = `SELECT address, blk AS block, ts AS time, txh AS tx_hash, dep AS deployer, fac AS factory FROM (
  SELECT toString(k.created) AS address, k.block AS blk, toUnixTimestamp(k.time) AS ts, toString(k.tx_hash) AS txh,
    toString(x.\`from\`) AS dep, if(k.creator != x.\`from\`, toString(k.creator), '') AS fac
  FROM (SELECT * FROM creations FINAL) AS k INNER JOIN (SELECT hash, \`from\` FROM raw_txs WHERE status = 1) AS x ON x.hash = k.tx_hash)`;

const missing = await rows<{ address: string; block: string; time: number; tx_hash: string; deployer: string; factory: string }>(
  `SELECT * FROM (${CREATED}) WHERE address NOT IN (SELECT address FROM contracts) ORDER BY block`);
let added = 0;
for (let i = 0; i < missing.length; i += 500) added += await writeContracts(up, missing.slice(i, i + 500).map((c) => ({ ...c, created: 1 })));

type Row = Record<string, unknown> & { address: string; block: string; fingerprint: string; created: number; first_of_kind: number; version: string };
const seenByLog = await rows<Row & { c_block: string; c_time: number; c_tx: string; c_deployer: string; c_factory: string }>(
  `SELECT c.*, k.block AS c_block, k.time AS c_time, k.tx_hash AS c_tx, k.deployer AS c_deployer, k.factory AS c_factory
   FROM (SELECT * FROM contracts FINAL WHERE created = 0) AS c INNER JOIN (${CREATED}) AS k ON k.address = c.address`);
const upgraded = seenByLog.map(({ c_block, c_time, c_tx, c_deployer, c_factory, ...c }) =>
  ({ ...c, block: c_block, time: c_time, tx_hash: c_tx, deployer: c_deployer, factory: c_factory, created: 1, version: String(BigInt(String(c.version)) + 1n) }));
await insert("contracts", upgraded, `contracts-redo:upgrade:${upgraded.length}`);

// (UInt64 comes back as a string in JSON, so version is never re-aliased: an alias with a column's name breaks the query)
// ponytail: reads every fingerprinted row (~50K on 2026-11-01); page it once that grows past a few hundred thousand
const all = await rows<Row>("SELECT * FROM contracts FINAL WHERE fingerprint != '' ORDER BY block, address");
const first = new Set<string>(), changed: Row[] = [];
let firsts = 0;
for (const r of all) {
  const f = !first.has(r.fingerprint) && r.created === 1 ? 1 : 0;
  first.add(r.fingerprint);
  firsts += f;
  if (f !== r.first_of_kind) changed.push({ ...r, first_of_kind: f, version: String(BigInt(String(r.version)) + 1n) });
}
await insert("contracts", changed, `contracts-redo:first:${changed.length}:${all.length}`);
console.log(JSON.stringify({ missing: missing.length, added, upgraded: upgraded.length, firstOfKindChanged: changed.length, firstOfKindNow: firsts }));
process.exit(0);
