import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
if (!projectId) throw new Error("Missing Supabase project_id");
const container = process.env.SUPABASE_DB_CONTAINER ?? `supabase_db_${projectId}`;
for (const file of ["rls_smoke.sql", "admin_member_fixes.sql", "solve_semantics.sql", "todo_board_semantics.sql", "one_way_lifecycle.sql", "proposal_replacement.sql", "live_quick_one_way.sql", "selected_day_publication.sql", "coordinator_planning.sql", "proposal_day_boundary.sql", "status_notifications.sql", "week_opening.sql"]) {
  console.log(`Database checks: ${file}`);
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
    input: readFileSync(new URL(`../supabase/tests/${file}`, import.meta.url)),
    stdio: ["pipe", "inherit", "inherit"],
  });
}
