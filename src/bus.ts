// Redis pub/sub between ingest and the API. Optional: without REDIS_URL ingest just doesn't publish.
import { createClient } from "redis";
import { cfg } from "./config.ts";

/** One message per ingested batch: [{header, logs}] in JSON-RPC shapes, oldest block first. */
export const BLOCKS = "rh:blocks";

export async function connect() {
  if (!cfg.redisUrl) return null;
  const c = createClient({ url: cfg.redisUrl });
  c.on("error", (e: Error) => console.warn(`[redis] ${e.message}`));
  await c.connect();
  return c;
}
