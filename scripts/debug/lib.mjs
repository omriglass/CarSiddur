// scripts/debug/lib.mjs — pure helpers of the debug copy (scripts/debug/debug.mjs), unit-tested in lib.test.mjs.

/** The Sunday (YYYY-MM-DD) of the Asia/Jerusalem week holding `instant`, shifted by `weeks`. */
export function weekStartOf(instant, weeks = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
    .formatToParts(instant);
  const get = (type) => parts.find((p) => p.type === type).value;
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const day = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
  day.setUTCDate(day.getUTCDate() - dow + 7 * weeks);
  return day.toISOString().slice(0, 10);
}

/**
 * Which weeks a load keeps (null = all), relative to the moment the dump was pulled. No --week: this week
 * and next week (late in the week the app already opens on next week).
 */
export function selectedWeeks({ week = null, withPrevious = false, all = false }, pulledAt) {
  if (all) return null;
  if (week === null) {
    const current = weekStartOf(new Date(pulledAt));
    return [...(withPrevious ? [weekStartOf(new Date(pulledAt), -1)] : []), current, weekStartOf(new Date(pulledAt), 1)];
  }
  const shift = { this: 0, next: 1, prev: -1 }[week];
  let target;
  if (shift !== undefined) target = weekStartOf(new Date(pulledAt), shift);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(week)) target = weekStartOf(new Date(`${week}T12:00:00Z`));
  else throw new Error(`--week must be this, next, prev or YYYY-MM-DD (got ${week})`);
  if (!withPrevious) return [target];
  return [weekStartOf(new Date(`${target}T12:00:00Z`), -1), target];
}

/** The first JSON object in `out` (the CLI may print more after it). */
export function firstJsonObject(out) {
  const start = out.indexOf("{");
  if (start < 0) throw new Error(`no JSON in output:\n${out}`);
  let depth = 0;
  let inString = false;
  for (let i = start; i < out.length; i++) {
    const c = out[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(out.slice(start, i + 1));
  }
  throw new Error("unterminated JSON in output");
}

/** config.toml of the debug stack: own project id, ports 6073x, app URL on 6073, no seed. */
export function debugConfig(config, { projectId, appUrl }) {
  return config
    .replace(/^project_id = ".*"$/m, `project_id = "${projectId}"`)
    .replace(/^(\s*#?\s*(?:port|shadow_port|smtp_port|pop3_port)\s*=\s*)5432(\d)\b/gm, "$16073$2")
    .replace(/^(\s*inspector_port\s*=\s*)8083/m, "$160738")
    .replace(/^site_url = ".*"$/m, `site_url = "${appUrl}"`)
    .replace(/^additional_redirect_urls = \[.*\]$/m, `additional_redirect_urls = ["${appUrl}", "${appUrl}/"]`)
    .replace(/(\[db\.seed\][^[]*?enabled = )true/, "$1false");
}
