// REQ §13.139 (a): a release with something worth telling people has a "מה חדש" entry; a minor release (small fixes,
// UI touch-ups) has none and is released quietly — the top entry stays the one already delivered, so nobody gets a new
// inbox message. `npm run release` refuses only when a new entry is not the top one (the top entry is the one delivered
// to people's inboxes). Write entries with the `write-changelog` skill (.claude/skills/write-changelog).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHANGELOG_FILE = "src/i18n/he.changelog.ts";

/** The entry ids in source order (newest first). */
export function changelogIds(source) {
  return [...String(source ?? "").matchAll(/^\s*id:\s*"([^"]+)"/gm)].map((match) => match[1]);
}

/** `{ ok, minor, newIds, top, message }` for the changelog at the last release vs now; `minor` = no new entry. */
export function evaluateChangelog(sourceAtLastRelease, sourceNow) {
  const before = new Set(changelogIds(sourceAtLastRelease));
  const ids = changelogIds(sourceNow);
  const newIds = ids.filter((id) => !before.has(id));
  const top = ids[0] ?? null;
  if (newIds.length === 0) {
    return { ok: true, minor: true, newIds, top, message: `no new "מה חדש" entry since the last release — minor release: no changelog, nobody is told (add an entry with the write-changelog skill if this release should be announced).` };
  }
  if (!newIds.includes(top)) {
    return { ok: false, minor: false, newIds, top, message: `the newest entry must be at the top of ${CHANGELOG_FILE} (top is "${top}", new: ${newIds.join(", ")}).` };
  }
  return { ok: true, minor: false, newIds, top, message: `changelog entry "${top}" is new since the last release.` };
}

/** Reads the file at `lastTag` (empty before the first changelog) and in the working tree. */
export function checkChangelog(lastTag, repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  let atTag = "";
  if (lastTag) {
    try {
      atTag = execFileSync("git", ["show", `${lastTag}:${CHANGELOG_FILE}`], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      atTag = "";
    }
  }
  return evaluateChangelog(atTag, readFileSync(path.join(repoRoot, CHANGELOG_FILE), "utf8"));
}
