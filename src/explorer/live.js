// The home page's live feed: polls /live (server-rendered rows, cached 1 s for everyone) and feeds rows newer than the
// ones it shows (data-o: block, or block and tx index) in at the top, spread over the poll interval so the list moves like the chain does. Pointing at a list (or focusing
// into it) pauses it; a hidden tab doesn't poll. Without this script the page refreshes itself (<noscript>).
"use strict";
// The search box: what the text is (a block, a tx, an address, a token's name) as it's typed or pasted, in a box under it.
// Only an address asks the server (/hint/<address>, cached 60 s), whether it's a token, a contract or a wallet.
(() => {
  const form = document.querySelector("header form[role=search]"), input = form && form.querySelector("input");
  if (!input) return;
  const box = document.createElement("div");
  box.className = "hint"; box.hidden = true;
  form.append(box);
  const item = (href, kind, label) => {
    const a = document.createElement("a"), t = document.createElement("span");
    a.href = href; t.className = "tag"; t.textContent = kind;
    a.append(t, " ", label);
    return a;
  };
  const put = (el) => { box.replaceChildren(...(el ? [el] : [])); box.hidden = !el; };
  let seq = 0;
  const update = async () => {
    const s = input.value.trim(), my = ++seq;
    if (/^\d{1,12}$/.test(s)) return put(item(`/block/${Number(s)}`, "Block", `#${Number(s).toLocaleString("en-US")}`));
    if (/^0x[0-9a-f]{64}$/i.test(s)) return put(item(`/search?q=${s.toLowerCase()}`, "Transaction", `${s.slice(0, 10)}…${s.slice(-8)}`));
    if (/^0x[0-9a-f]{40}$/i.test(s)) {
      const a = s.toLowerCase();
      put(item(`/address/${a}`, "Address", `${a.slice(0, 8)}…${a.slice(-6)}`));
      try {
        const r = await fetch(`/hint/${a}`, { credentials: "same-origin" });
        const got = r.ok && !r.redirected && new DOMParser().parseFromString(await r.text(), "text/html").body.firstElementChild;
        if (got && my === seq) put(document.importNode(got, true));
      } catch { /* the plain address link stays */ }
      return;
    }
    put(s.length >= 2 && !/^0x[0-9a-f]*$/i.test(s) ? item(`/search?q=${encodeURIComponent(s)}`, "Token", `named “${s}”`) : null);
  };
  input.addEventListener("input", update);
  input.addEventListener("focus", update);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") box.hidden = true;
    if (e.key === "ArrowDown" && !box.hidden) { e.preventDefault(); box.querySelector("a")?.focus(); }
  });
  box.addEventListener("keydown", (e) => { if (e.key === "ArrowUp" || e.key === "Escape") { e.preventDefault(); input.focus(); } });
  form.addEventListener("focusout", () => setTimeout(() => { if (!form.contains(document.activeElement)) box.hidden = true; }, 150));
})();

// Chain charts (charts.ts): a crosshair and readout at the nearest point on hover, or on keyboard focus with the arrow
// keys. Values go in with textContent; the table under each chart has them all without this.
(() => {
  for (const svg of document.querySelectorAll("svg[data-pts]")) {
    let pts;
    try { pts = JSON.parse(svg.dataset.pts); } catch { continue; }
    const tip = svg.parentElement.querySelector(".tip"), xh = svg.querySelector(".xh"), dot = svg.querySelector(".dot");
    if (!tip || !xh || !dot || !pts.length) continue;
    const [val, when, band] = tip.children;
    let at = -1;
    const show = (i) => {
      at = Math.max(0, Math.min(pts.length - 1, i));
      const [x, y, t, v, b] = pts[at];
      for (const [k, n] of [["x1", x], ["x2", x]]) xh.setAttribute(k, n);
      dot.setAttribute("cx", x); dot.setAttribute("cy", y);
      xh.setAttribute("visibility", "visible"); dot.setAttribute("visibility", "visible");
      val.textContent = v; when.textContent = t; band.textContent = b ? `p10 – p90: ${b}` : ""; band.hidden = !b;
      tip.hidden = false;
      const w = svg.getBoundingClientRect().width, px = (x / svg.viewBox.baseVal.width) * w, half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(Math.max(px, half), w - half)}px`;
    };
    const hide = () => { at = -1; tip.hidden = true; xh.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
    svg.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * svg.viewBox.baseVal.width;
      let best = 0;
      for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - x) < Math.abs(pts[best][0] - x)) best = i;
      show(best);
    });
    svg.addEventListener("pointerleave", hide);
    svg.addEventListener("focus", () => show(pts.length - 1));
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      show(at + (e.key === "ArrowRight" ? 1 : -1));
    });
  }
})();

(() => {
  const POLL = 1500, KEEP = 15; // /live carries ~4 s of blocks, so a poll never skips one
  const lists = ["blocks", "txs"].map((id) => { const el = document.getElementById(id); return { el, badge: el && el.closest("section").querySelector(".live"), queue: [], held: false }; });
  const tiles = document.getElementById("tiles"), net = document.getElementById("net");
  if (!lists.every((l) => l.el) || !tiles) return;
  document.documentElement.classList.add("js");
  let off = false;
  // each list's badge: Paused while pointed at (that list only), Reconnecting while /live fails, else Live
  const show = (l) => {
    if (!l.badge) return;
    const s = off ? "off" : l.held ? "paused" : "live";
    l.badge.hidden = false; l.badge.dataset.state = s;
    l.badge.querySelector("span").textContent = s === "live" ? "Live" : s === "paused" ? "Paused" : "Reconnecting";
  };
  lists.forEach(show);
  for (const l of lists) {
    const hold = (on) => { l.held = on; show(l); };
    l.el.addEventListener("pointerenter", () => hold(true));
    l.el.addEventListener("pointerleave", () => hold(false));
    l.el.addEventListener("focusin", () => hold(true));
    l.el.addEventListener("focusout", () => hold(false));
  }

  // ages: "3 s ago", kept current
  const ago = (ts) => {
    const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
    return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
  };
  const tick = (root) => root.querySelectorAll("time.age[data-ts]").forEach((t) => { t.textContent = ago(Number(t.dataset.ts)); });
  setInterval(() => tick(document), 1000);

  // drip: one queued row at a time, oldest first, so the newest ends on top
  const drip = (now) => {
    for (const l of lists) {
      if (l.held || !l.queue.length) continue;
      const every = Math.max(60, POLL / Math.max(1, l.queue.length + 1));
      if (now - (l.at || 0) < every) continue;
      l.at = now;
      const row = l.queue.shift();
      tick(row);
      row.classList.add("in");
      l.el.prepend(row);
      while (l.el.children.length > KEEP) l.el.lastElementChild.remove();
    }
    requestAnimationFrame(drip);
  };
  requestAnimationFrame(drip);

  let wait = POLL;
  const poll = async () => {
    if (document.hidden) return;
    try {
      const r = await fetch("/live", { cache: "no-store", credentials: "same-origin" });
      if (!r.ok || r.redirected) throw new Error(String(r.status));
      const doc = new DOMParser().parseFromString(await r.text(), "text/html");
      // the tiles and the Network table (recomputed every 15 s on the server)
      for (const [mine, id] of [[tiles, "tiles"], [net, "net"]]) {
        const got = doc.getElementById(id);
        if (mine && got) mine.replaceChildren(...[...got.children].map((c) => document.importNode(c, true)));
      }
      for (const l of lists) {
        const got = doc.getElementById(l.el.id);
        if (!got) throw new Error("no rows");
        const last = l.queue.at(-1) ?? l.el.firstElementChild, top = last ? Number(last.dataset.o) : 0;
        const fresh = [...got.children].filter((c) => Number(c.dataset.o) > top).reverse().map((c) => document.importNode(c, true));
        l.queue.push(...fresh);
        const cap = l.held ? KEEP : 40; // paused: older ones would scroll off anyway
        if (l.queue.length > cap) l.queue.splice(0, l.queue.length - cap);
      }
      wait = POLL; off = false;
    } catch {
      wait = Math.min(wait * 2, 30000); off = true;
    }
    lists.forEach(show);
  };
  const loop = async () => { await poll(); setTimeout(loop, wait); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  setTimeout(loop, POLL);
})();
