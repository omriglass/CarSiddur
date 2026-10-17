// scripts/replay/lib.mjs — shared by the replay scripts: which stack they talk to, and the
// hard refusal of every other stack (the owner's 54321/54322 in particular).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPLAY_PROJECT_ID = "carshare-replay";
export const REPLAY_API = "http://127.0.0.1:56321";
export const REPLAY_DB_CONTAINER = `supabase_db_${REPLAY_PROJECT_ID}`;
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** The owner's own local stack — written to only by `load-week.mjs --owner-stack`, on the owner's explicit request. */
export const OWNER_DB_CONTAINER = "supabase_db_carshare-nevo";

/** Throws unless `container` is the replay stack's database container (or the owner's stack, when explicitly allowed). */
export function assertReplayContainer(container, { ownerStack = false } = {}) {
  if (ownerStack && container === OWNER_DB_CONTAINER) return;
  if (container !== REPLAY_DB_CONTAINER) {
    throw new Error(`replay: refusing database container ${container} — replays only write to ${REPLAY_DB_CONTAINER}`);
  }
}

/** Runs `sql` through psql inside the replay database container; throws on any error. */
export function psql(sql, { container = REPLAY_DB_CONTAINER, quiet = true, ownerStack = false } = {}) {
  assertReplayContainer(container, { ownerStack });
  const res = spawnSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-X", ...(quiet ? ["-q"] : []), "-At"],
    { input: sql, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (res.status !== 0) throw new Error(`psql failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
}
