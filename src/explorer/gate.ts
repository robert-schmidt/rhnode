// Access tokens for the explorer's pages (on when EXPLORER_SECRET is set). A token is `<login>.<issued>.<mac>`, the mac an
// HMAC of the first two parts under the secret, so nothing is stored: EXPLORER_REVOKED or a new secret takes tokens back.
// Self-serve: /access hands the browser a code, bound to it by a signed cookie. The visitor opens a GitHub issue containing
// the code (and stars the repo); /access/claim finds that issue and mints a token for its author. The token is shown only
// to the browser that holds the code's cookie, never posted on GitHub, so a code copied from a public issue is useless.
// By hand: `node src/explorer/gate.ts mint <login>` (with EXPLORER_SECRET in the env).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cfg } from "../config.ts";
import { REPO } from "./html.ts";

export const REPO_NAME = cfg.explorer.repo || REPO.replace("https://github.com/", "");
export const gated = () => cfg.explorer.secret !== "";
const mac = (s: string) => createHmac("sha256", cfg.explorer.secret).update(s).digest("base64url").slice(0, 32);
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function mint(login: string, now = Date.now()): string {
  const body = `${login.toLowerCase()}.${Math.floor(now / 1000)}`;
  return `${body}.${mac(body)}`;
}
/** The GitHub login a token was issued to, or null. */
export function verify(token: string | undefined): string | null {
  const m = (token ?? "").trim().match(/^([a-z0-9-]{1,39})\.(\d{1,12})\.([A-Za-z0-9_-]{32})$/);
  if (!m || !same(mac(`${m[1]}.${m[2]}`), m[3]) || cfg.explorer.revoked.has(m[1])) return null;
  return m[1];
}

export const CODE_PREFIX = "rhnode-access-";
export function challenge(): { code: string; cookie: string } {
  const code = randomBytes(8).toString("hex");
  return { code, cookie: `${code}.${mac(`code:${code}`)}` };
}
export function codeOf(cookie: string | undefined): string | null {
  const m = (cookie ?? "").match(/^([0-9a-f]{16})\.([A-Za-z0-9_-]{32})$/);
  return m && same(mac(`code:${m[1]}`), m[2]) ? m[1] : null;
}

// --- GitHub (keyless: 60 requests/h per IP; both lists are memoized, so claims cost at most a few per minute) ---

async function gh<T>(path: string): Promise<T> {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "rhnode-explorer",
      ...(cfg.explorer.githubToken ? { authorization: `Bearer ${cfg.explorer.githubToken}` } : {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`github ${r.status}${r.headers.get("x-ratelimit-remaining") === "0" ? " (rate limited)" : ""}`);
  return r.json() as Promise<T>;
}
function memo<T>(fn: () => Promise<T>) {
  let at = 0, p: Promise<T> | null = null;
  return (maxAgeMs: number) => {
    if (!p || Date.now() - at > maxAgeMs) { at = Date.now(); p = fn(); p.catch(() => { p = null; }); }
    return p;
  };
}
const issues = memo(() => gh<{ title: string; body: string | null; user: { login: string } }[]>(
  `/repos/${REPO_NAME}/issues?state=all&sort=created&direction=desc&per_page=100`));
// ponytail: walks every stargazer page (≤30, i.e. 3,000 stars); past that, ask GitHub per user with a token instead
const stars = memo(async () => {
  const s = new Set<string>();
  for (let page = 1; page <= 30; page++) {
    const p = await gh<{ login: string }[]>(`/repos/${REPO_NAME}/stargazers?per_page=100&page=${page}`);
    for (const u of p) s.add(u.login.toLowerCase());
    if (p.length < 100) break;
  }
  return s;
});

/** The login whose issue carries the code (and who starred the repo), or why not. */
export async function claim(code: string): Promise<{ login: string } | { error: string }> {
  // the oldest issue with the code: a later copy of it (by someone else) never wins
  const find = async (age: number) => (await issues(age)).findLast((i) => `${i.title}\n${i.body ?? ""}`.includes(CODE_PREFIX + code));
  const hit = (await find(30_000)) ?? (await find(10_000));
  if (!hit) return { error: "No issue with your code yet. GitHub can take a few seconds to list a new one: try again shortly." };
  const login = hit.user.login.toLowerCase();
  if (cfg.explorer.revoked.has(login)) return { error: "Access for this account was withdrawn." };
  if (cfg.explorer.requireStar && !(await stars(120_000)).has(login) && !(await stars(15_000)).has(login))
    return { error: `Found your issue, @${login}, but not your star yet. Star the repo, then try again.` };
  return { login };
}

if (import.meta.main && process.argv[2] === "mint" && /^[A-Za-z0-9-]{1,39}$/.test(process.argv[3] ?? "")) {
  if (!gated()) throw new Error("EXPLORER_SECRET is not set");
  console.log(mint(process.argv[3]));
}
