// REQ §13.138 (d): "שלח את כל ההצעות" — the board's ⋮ menu item. Lists, per day, the week's unsent Sadran drafts and held
// board updates (every day ticked; untick a day still being worked on), sends the drafts (`send_draft_proposals`) and
// delivers the updates (`flush_held_notices`), then shows what could not be sent (with the reason) and the optional
// WhatsApp messages, one per party, exactly as the composer would write them.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { env } from "@/lib/env";
import { toAppError } from "@/lib/rpc";

import { fetchProposalPartyTexts, type HeldNotice, type ProposalRow, type SendDraftResult } from "../../api";
import { useProfilesByIds, useSendDraftProposalsMutation } from "../../hooks";
import { sadranKeys } from "../../keys";
import { WhatsappDialog } from "../../proposals/components/WhatsappDialog";
import { renderTemplate } from "../../proposals/waLink";
import { heldUpdateCount } from "../heldUpdates";
import { sendAllCount } from "../sendAllCount";

/** One unsent Sadran draft, with the day it belongs to (its request's day) and who it is for. */
export interface PendingDraft {
  proposal: ProposalRow;
  /** yyyy-MM-dd (Asia/Jerusalem). */
  day: string;
  requesterName: string;
}

export interface SendAllDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  departmentId: string;
  weekStart: string;
  drafts: readonly PendingDraft[];
  /** REQ §13.138 (c): held board notices (a person on a ride/request = one update). */
  held: readonly HeldNotice[];
}

export function SendAllDialog({ open, onOpenChange, departmentId, weekStart, drafts, held }: SendAllDialogProps) {
  const days = useMemo(
    () => [...new Set([...drafts.map((draft) => draft.day), ...held.flatMap((row) => (row.day ? [row.day] : []))])].sort(),
    [drafts, held],
  );
  const weekLevel = heldUpdateCount(held, null);
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [results, setResults] = useState<SendDraftResult[] | null>(null);
  // Results outlive the drafts list (sent drafts leave it), so remember what each sent proposal was.
  const [sentDrafts, setSentDrafts] = useState<ReadonlyMap<string, PendingDraft>>(new Map());
  const sendMutation = useSendDraftProposalsMutation();
  const ticked = days.filter((day) => !unticked.has(day));

  function close(next: boolean) {
    if (next) return;
    onOpenChange(false);
    setResults(null);
    setUnticked(new Set());
  }

  async function send() {
    const byId = new Map(drafts.map((draft) => [draft.proposal.id, draft]));
    try {
      const { proposals: sent, delivered } = await sendMutation.mutateAsync({ departmentId, weekStart, days: ticked.length === days.length ? null : ticked });
      setSentDrafts(byId);
      setResults(sent);
      const okCount = sent.filter((row) => row.ok).length;
      if (okCount || delivered) toast.success(tv("sendAll.sent", { count: String(okCount), updates: String(delivered) }));
    } catch { /* toast shown by the mutation */ }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto" data-testid="send-all-dialog">
        <DialogHeader>
          <DialogTitle>{he.sendAll.title}</DialogTitle>
          <DialogDescription>{results ? he.sendAll.whatsappHelp : he.sendAll.help}</DialogDescription>
        </DialogHeader>
        {results ? (
          <SendAllResults results={results} drafts={sentDrafts} />
        ) : days.length === 0 && weekLevel === 0 ? (
          <p className="text-sm text-muted-foreground">{he.sendAll.none}</p>
        ) : (
          <ul className="space-y-2">
            {held.length ? <li className="text-xs text-muted-foreground">{he.sendAll.updatesHint}</li> : null}
            {weekLevel ? <li className="text-sm">{sendAllCount("weekUpdates", weekLevel)}</li> : null}
            {days.map((day) => {
              const ofDay = drafts.filter((draft) => draft.day === day);
              const updates = heldUpdateCount(held, day);
              return (
                <li key={day} className="rounded-md border p-2">
                  <label className="flex items-center gap-2 font-medium">
                    <Checkbox
                      checked={!unticked.has(day)}
                      data-testid={`send-all-day-${day}`}
                      onCheckedChange={(value) => setUnticked((prev) => {
                        const next = new Set(prev);
                        if (value) next.delete(day); else next.add(day);
                        return next;
                      })}
                    />
                    {[formatDayDate(day),
                      ofDay.length ? sendAllCount("dayProposals", ofDay.length) : null,
                      updates ? sendAllCount("dayUpdates", updates) : null].filter(Boolean).join(" · ")}
                  </label>
                  {ofDay.length ? (
                    <ul className="ps-6 text-xs text-muted-foreground" data-testid={`send-all-items-${day}`}>
                      {ofDay.map((draft) => <li key={draft.proposal.id}>{`${draft.requesterName} · ${he.proposal.type[draft.proposal.type]}`}</li>)}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter className="gap-2">
          {results ? (
            <Button onClick={() => close(false)}>{he.sendAll.done}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)}>{he.common.cancel}</Button>
              <Button onClick={() => void send()} disabled={(ticked.length === 0 && weekLevel === 0) || sendMutation.isPending} data-testid="send-all-confirm">
                {sendMutation.isPending ? he.sendAll.sending : he.sendAll.send}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SendAllResults({ results, drafts }: { results: readonly SendDraftResult[]; drafts: ReadonlyMap<string, PendingDraft> }) {
  const failed = results.filter((row) => !row.ok);
  const sent = results.flatMap((row) => (row.ok ? [row] : []));
  const partyIds = [...new Set(sent.flatMap((row) => Object.keys(row.party_tokens)))];
  const contactsQuery = useProfilesByIds(partyIds);
  const mergeIds = sent.filter((row) => drafts.get(row.proposal_id)?.proposal.type === "merge").map((row) => row.proposal_id);
  // REQ §13.101 b: a merge reaches each party with its own text.
  const partyTextsQuery = useQuery({
    queryKey: [...sadranKeys.all, "proposalPartyTexts", "sendAll", ...mergeIds],
    queryFn: async () => Object.fromEntries(await Promise.all(mergeIds.map(async (id) => [id, await fetchProposalPartyTexts(id)] as const))),
    enabled: mergeIds.length > 0,
  });
  const contactById = new Map((contactsQuery.data ?? []).map((contact) => [contact.id, contact]));

  return (
    <div className="space-y-3 text-sm">
      {failed.length ? (
        <div className="space-y-1 rounded-md border border-destructive p-2" data-testid="send-all-failed">
          <p className="font-medium">{he.sendAll.failedTitle}</p>
          {failed.map((row) => (
            <p key={row.proposal_id}>
              {tv("sendAll.failedRow", { name: drafts.get(row.proposal_id)?.requesterName ?? "", reason: toAppError({ message: row.error }).message })}
            </p>
          ))}
        </div>
      ) : null}
      {sent.length ? (
        <div className="space-y-2" data-testid="send-all-whatsapp">
          <p className="font-medium">{he.sendAll.whatsappTitle}</p>
          {sent.flatMap((row) => Object.entries(row.party_tokens).map(([profileId, token]) => {
            const contact = contactById.get(profileId);
            if (!contact?.phone) return null;
            const base = partyTextsQuery.data?.[row.proposal_id]?.[profileId] ?? drafts.get(row.proposal_id)?.proposal.reason_he ?? "";
            const message = renderTemplate(base, { link: `${env.VITE_APP_URL}/p/${token}` });
            return <WhatsappDialog key={`${row.proposal_id}:${profileId}`} name={contact.full_name} phone={contact.phone} message={message} />;
          }))}
        </div>
      ) : null}
    </div>
  );
}
