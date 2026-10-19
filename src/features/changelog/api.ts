import { rpc } from "@/lib/rpc";

/** REQ §13.139 (b): the quiet "מה חדש" message, into my own inbox once per entry (never a push). */
export async function deliverChangelog(entryId: string, title: string, body: string): Promise<boolean> {
  return await rpc("deliver_changelog", { p_entry_id: entryId, p_title: title, p_body: body });
}
