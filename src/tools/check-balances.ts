// M2 acceptance: for N tokens whose whole history we hold (serve_tokens.complete), every holder's balance in
// agg_balances equals balanceOf() on chain. Both are taken at one block C (the tip cursor): our side is the
// aggregate minus whatever ingest added after C, so the check runs against live ingest without a race.
// `node src/tools/check-balances.ts [N=20]`. Exits 1 on any mismatch.
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";
import { cfg } from "../config.ts";
import { ch, rows } from "../ch.ts";
import { MULTICALL3 } from "../chain/constants.ts";
import { upstream } from "../chain/upstream.ts";

const n = Number(process.argv[2] ?? 20);
const MC = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])"]);
const BAL = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const up = upstream(cfg.upstreamHttp);

const C = Number((await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = 'tip'"))[0].block);
const tokens = await rows<{ token: string; symbol: string }>(
  "SELECT token, symbol FROM serve_tokens FINAL WHERE complete = 1 ORDER BY holder_count DESC LIMIT {n:UInt32}", { n },
);
let checked = 0, bad = 0;
for (const { token, symbol } of tokens) {
  const ours = await rows<{ holder: string; b: string }>(
    `SELECT holder, toString(sum(v)) AS b FROM (
       SELECT holder, balance AS v FROM agg_balances WHERE token = {t:String}
       UNION ALL
       SELECT h.1 AS holder, -h.2 AS v FROM ev_transfers
       ARRAY JOIN [(\`from\`, -toInt256(amount) * sign), (\`to\`, toInt256(amount) * sign)] AS h
       WHERE token = {t:String} AND standard = 'erc20' AND block > {c:UInt64}
     ) WHERE holder != '0x0000000000000000000000000000000000000000' GROUP BY holder LIMIT 2000`,
    { t: token, c: C },
  );
  for (let i = 0; i < ours.length; i += 500) {
    const part = ours.slice(i, i + 500);
    const data = encodeFunctionData({ abi: MC, functionName: "aggregate3", args: [part.map((h) => ({
      target: token as `0x${string}`, allowFailure: true, callData: encodeFunctionData({ abi: BAL, functionName: "balanceOf", args: [h.holder as `0x${string}`] }),
    }))] });
    const res = decodeFunctionResult({ abi: MC, functionName: "aggregate3", data: await up.call<`0x${string}`>("eth_call", [{ to: MULTICALL3, data }, "0x" + C.toString(16)]) });
    part.forEach((h, j) => {
      const chain = res[j].success ? decodeFunctionResult({ abi: BAL, functionName: "balanceOf", data: res[j].returnData }) : null;
      checked++;
      if (chain === null || chain !== BigInt(h.b)) { bad++; console.log(`MISMATCH ${symbol} ${token} ${h.holder}: ours ${h.b} chain ${chain}`); }
    });
  }
  console.log(`${symbol.padEnd(12)} ${token} holders ${ours.length}`);
}
console.log(JSON.stringify({ block: C, tokens: tokens.length, holders: checked, mismatches: bad }));
await ch.close();
process.exit(bad ? 1 : 0);
