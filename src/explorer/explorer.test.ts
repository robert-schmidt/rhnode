import assert from "node:assert/strict";
import { test } from "node:test";
import { compact, html, JS_PATH, page, units } from "./html.ts";
import { route } from "./index.ts";

const XSS = `"><script>alert(1)</script><img src=x onerror=alert(1)>`;

test("chain and request data come out escaped", () => {
  const out = page(XSS, html`<p>${XSS}</p><a href="/x/${XSS}">${[XSS, XSS]}</a>`, { q: XSS });
  assert.ok(!out.includes("<script>alert") && !out.includes("<img src=x"));
  assert.equal(out.split("&lt;script&gt;").length - 1, 6);
});

test("units", () => {
  assert.equal(units(1234567890000000000000n, 18), "1,234.56789");
  assert.equal(units(1n, 18), "<0.000001");
  assert.equal(units("-1500000", 6), "-1.5");
  assert.equal(units(42n, 0), "42");
});

test("compact", () => {
  assert.equal(compact(46007944562000000000000000n, 18), "46.01M");
  assert.equal(compact(3091937700n, 6), "3,091.94");
  assert.equal(compact(34200000000000000n, 18), "0.0342");
  assert.equal(compact(5n, 18), "<0.0001");
  assert.equal(compact(0n, 18), "0");
});

test("only the live home page loads the script, and keeps a no-script refresh", () => {
  const p = page("x", html``, { refresh: 10, live: true });
  assert.ok(p.includes(`<script src="${JS_PATH}" defer>`) && p.includes('<noscript><meta http-equiv="refresh" content="10"></noscript>'));
  assert.ok(!page("x", html``, { refresh: 10 }).includes("<script"));
  assert.equal((route("/live", new URLSearchParams()) as { key: string }).key, "/live");
});

test("route validates before anything is queried", () => {
  const q = new URLSearchParams();
  for (const bad of ["/block/1e9", "/block/0x12", "/tx/0xzz", `/tx/${encodeURIComponent(XSS)}`, "/address/0x123"])
    assert.equal((route(bad, q) as { key: string }).key, "/404", bad);
  assert.equal(route("/nope", q), null);
  assert.equal((route("/block/00042", q) as { key: string }).key, "/block/42");
  const A = "0x" + "Ab".repeat(20);
  assert.deepEqual(route(`/address/${A}`, q), { redirect: `/address/${A.toLowerCase()}` });
  assert.deepEqual(route(`/address/${A.toLowerCase()}`, new URLSearchParams("txb=5&evil=<x>")), { redirect: `/address/${A.toLowerCase()}?txb=5` });
  assert.equal((route(`/address/${A.toLowerCase()}`, new URLSearchParams("txb=5")) as { key: string }).key, `/address/${A.toLowerCase()}?txb=5`);
  assert.equal((route("/search", new URLSearchParams({ q: "x".repeat(500) })) as { q: string }).q.length, 100);
});

test("access tokens and codes", async () => {
  const { cfg } = await import("../config.ts");
  const g = await import("./gate.ts");
  (cfg.explorer as { secret: string }).secret = "test-secret";
  const t = g.mint("Alice-1");
  assert.equal(g.verify(t), "alice-1");
  assert.equal(g.verify(t.replace(/.$/, (c) => (c === "A" ? "B" : "A"))), null);
  assert.equal(g.verify(t.replace("alice-1", "bob")), null);
  assert.equal(g.verify(`${t}<x>`), null);
  cfg.explorer.revoked.add("alice-1");
  assert.equal(g.verify(t), null);
  cfg.explorer.revoked.delete("alice-1");
  const { code, cookie } = g.challenge();
  assert.equal(g.codeOf(cookie), code);
  assert.equal(g.codeOf(cookie.replace(code, "0".repeat(16))), null);
  (cfg.explorer as { secret: string }).secret = "other";
  assert.equal(g.verify(t), null);
});

test("push4s: dispatcher constants only (not PUSH4 bytes inside another push)", async () => {
  const { push4s } = await import("./names.ts");
  const s = push4s("0x63a9059cbb14" + "7f" + "63095ea7b3".padEnd(64, "0") + "00");
  assert.ok(s.has("0xa9059cbb"));
  assert.ok(!s.has("0x095ea7b3"));
});
