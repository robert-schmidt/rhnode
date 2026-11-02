import { test } from "node:test";
import assert from "node:assert/strict";
import { nitro } from "./nitro.ts";
import { upstream } from "./upstream.ts";

test("upstream: a node that isn't synced still answers for the blocks it has", async () => {
  const hosts: string[] = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body);
    if (method === "eth_blockNumber") return new Promise<Response>(() => {}); // the probe never answers: the head is ours to set
    hosts.push(new URL(url).host);
    return new Response('{"result":{}}');
  }) as typeof fetch;
  const rpc = upstream([{ url: "http://nitro:8547", rps: 100 }, { url: "http://public.example", rps: 100 }]);
  Object.assign(nitro, { head: 1_000, since: 0 });
  await rpc.call("eth_getBlockByNumber", ["0x3e8", true]); // 1,000: the node has it
  await rpc.call("eth_getBlockByNumber", ["0x3e9", true]); // 1,001: not yet
  await rpc.call("eth_getBlockByHash", [`0x${"ab".repeat(32)}`, true]);
  assert.deepEqual(hosts, ["nitro:8547", "public.example", "public.example"]);
});
