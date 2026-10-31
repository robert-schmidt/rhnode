// The home page's live feed: polls /live (server-rendered rows, cached 1 s for everyone) and feeds rows newer than the
// ones it shows (data-o: block, or block and tx index) in at the top, spread over the poll interval so the list moves like the chain does. Pointing at a list (or focusing
// into it) pauses it; a hidden tab doesn't poll. Without this script the page refreshes itself (<noscript>).
"use strict";
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
