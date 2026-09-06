// Pure parser for the "Import allow-list" textarea (docs/UX_FLOWS.md §5.2):
// pasted "name, email" lines, comma/tab/semicolon separated, optional header
// row, per-row status (new / existing / invalid email / duplicate). No I/O —
// classification against "does this email already exist" is injected via
// `existingEmails` so this stays a pure, easily unit-tested function; the
// caller (admin/members/api.ts) decides what "existing" means (an unconsumed
// invite vs. an already-registered profile).

export type ParsedInviteRowStatus = "new" | "existing" | "invalid_email" | "duplicate";

export interface ParsedInviteRow {
  name: string;
  email: string;
  status: ParsedInviteRowStatus;
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const SEPARATOR_RE = /[,;\t]/;

const HEADER_TOKENS = new Set(["name", "email", "e-mail", "full name", "שם", "שם מלא", "אימייל", "מייל", "דוא\"ל"]);

function looksLikeHeader(fields: string[]): boolean {
  if (fields.some((f) => EMAIL_RE.test(f.trim()))) return false;
  return fields.some((f) => HEADER_TOKENS.has(f.trim().toLowerCase()));
}

/**
 * Parses pasted lines into rows with a per-row status. Duplicate emails
 * within the pasted batch (case-insensitive) are flagged `duplicate` on the
 * second and later occurrence, keeping the first occurrence's own
 * new/existing status intact — matching "existing emails are updated (name
 * only), never duplicated" (§5.2).
 */
export function parseInviteLines(raw: string, existingEmails: ReadonlySet<string> = new Set()): ParsedInviteRow[] {
  const lowerExisting = new Set([...existingEmails].map((e) => e.trim().toLowerCase()));
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const rows: ParsedInviteRow[] = [];
  const seenEmails = new Set<string>();

  lines.forEach((line, index) => {
    const fields = line.split(SEPARATOR_RE).map((f) => f.trim());
    if (index === 0 && looksLikeHeader(fields)) return;

    const [rawName, rawEmail] = fields.length >= 2 ? fields : ["", fields[0] ?? ""];
    const name = (rawName ?? "").trim();
    const email = (rawEmail ?? "").trim().toLowerCase();

    if (!EMAIL_RE.test(email)) {
      rows.push({ name, email, status: "invalid_email" });
      return;
    }
    if (seenEmails.has(email)) {
      rows.push({ name, email, status: "duplicate" });
      return;
    }
    seenEmails.add(email);
    rows.push({ name, email, status: lowerExisting.has(email) ? "existing" : "new" });
  });

  return rows;
}
