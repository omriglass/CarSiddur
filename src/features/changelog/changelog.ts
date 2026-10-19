import type { ChangelogEntry } from "@/i18n/he.changelog";
import { he, tv } from "@/i18n/he";

/** Which sections a reader gets in their inbox message (REQ §13.139 b). */
export interface ChangelogReader {
  isSadran: boolean;
  isAdmin: boolean;
}

export type ChangelogSection = "users" | "sadran" | "admin";

/** The sections of `entry` for this reader, in display order, empty ones left out. */
export function sectionsFor(entry: ChangelogEntry, reader: ChangelogReader): ChangelogSection[] {
  const wanted: ChangelogSection[] = ["users", ...(reader.isSadran || reader.isAdmin ? ["sadran" as const] : []), ...(reader.isAdmin ? ["admin" as const] : [])];
  return wanted.filter((section) => entry[section].length > 0);
}

/** The quiet inbox message for this reader, or `null` when the version has nothing for them. */
export function inboxMessage(entry: ChangelogEntry, reader: ChangelogReader): { title: string; body: string } | null {
  const sections = sectionsFor(entry, reader);
  if (sections.length === 0) return null;
  const titled = sections.length > 1 || sections[0] !== "users";
  const body = sections
    .map((section) => [...(titled ? [`${he.changelog[section]}:`] : []), ...entry[section].map((line) => `• ${line}`)].join("\n"))
    .join("\n\n");
  return { title: tv("changelog.inboxTitle", { title: entry.title }), body };
}
