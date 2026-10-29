// Applies migrations/*.sql once each, in name order. `node src/migrate.ts`.
import { readdirSync, readFileSync } from "node:fs";
import { ch, rows } from "./ch.ts";
import { cfg } from "./config.ts";

const dir = new URL("../migrations/", import.meta.url);

export async function migrate(): Promise<string[]> {
  await ch.command({ query: "CREATE TABLE IF NOT EXISTS ctl_migrations (name String, applied_at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY name" });
  const done = new Set((await rows<{ name: string }>("SELECT name FROM ctl_migrations")).map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const sql = readFileSync(new URL(name, dir), "utf8")
      .replaceAll("${RAW_TTL_DAYS}", String(cfg.rawTtlDays))
      .replace(/^--.*$/gm, "");
    // ponytail: a migration that fails halfway is fixed by hand; statements are DDL, so there is no transaction to roll back.
    for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await ch.command({ query: stmt });
    await ch.insert({ table: "ctl_migrations", values: [{ name }], format: "JSONEachRow" });
    applied.push(name);
  }
  return applied;
}

if (import.meta.main) {
  const applied = await migrate();
  console.log(applied.length ? `applied ${applied.join(", ")}` : "up to date");
  await ch.close();
}
