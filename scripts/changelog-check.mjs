// REQ §13.139 (a): every release has a "מה חדש" entry. `npm run release` refuses when src/i18n/he.changelog.ts has no
// entry that the last release tag did not have, or when the new entry is not the top one (the top entry is the one
// delivered to people's inboxes). Write entries with the `write-changelog` skill (.claude/skills/write-changelog).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHANGELOG_FILE = "src/i18n/he.changelog.ts";

/** The entry ids in source order (newest first). */
export function changelogIds(source) {
  return [...String(source ?? "").matchAll(/^\s*id:\s*"([^"]+)"/gm)].map((match) => match[1]);
}

/** `{ ok, newIds, top, message }` for the changelog at the last release vs now. */
export function evaluateChangelog(sourceAtLastRelease, sourceNow) {
  const before = new Set(changelogIds(sourceAtLastRelease));
  const ids = changelogIds(sourceNow);
  const newIds = ids.filter((id) => !before.has(id));
  const top = ids[0] ?? null;
  if (newIds.length === 0) {
    return { ok: false, newIds, top, message: `no new "מה חדש" entry in ${CHANGELOG_FILE} since the last release — add one (skill: write-changelog).` };
  }
  if (!newIds.includes(top)) {
    return { ok: false, newIds, top, message: `the newest entry must be at the top of ${CHANGELOG_FILE} (top is "${top}", new: ${newIds.join(", ")}).` };
  }
  return { ok: true, newIds, top, message: `changelog entry "${top}" is new since the last release.` };
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
