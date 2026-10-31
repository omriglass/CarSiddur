import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { Json } from "@/integrations/supabase/types";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import type { FreedOfferCandidate } from "../../api";
import { useAwardFreedOptionMutation, useDiscussFreedCandidatesMutation, useFreedOfferCandidates } from "../../hooks";
import { freedOptionRows, openFreedCandidates, type FreedOptionRow } from "../freedOptions";

/** Options shown before "more" (REQ §13.168 (f): the best few; the rest behind a toggle). */
const SHOWN_OPTIONS = 4;

function timeRange(c: FreedOfferCandidate): string {
  return c.departAt && c.returnAt ? `${formatTime(new Date(c.departAt))}–${formatTime(new Date(c.returnAt))}` : "";
}

function PersonLine({ person }: { person: FreedOfferCandidate }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      <span className="font-medium">{person.name}</span>
      <span dir="ltr" className="text-muted-foreground">{timeRange(person)}</span>
      {person.destination ? <span className="text-muted-foreground">{tv("route.to", { destination: person.destination })}</span> : null}
      {person.planB ? <Badge variant="outline" className="text-[10px]">{he.sadranClaims.planB}</Badge> : null}
      {person.claimStatus === "withdrawn" ? <span className="text-muted-foreground line-through">{he.sadranClaims.steppedOut}</span> : null}
      {person.claimStatus === "declined" ? <span className="text-muted-foreground line-through">{he.sadranClaims.placedElsewhere}</span> : null}
    </span>
  );
}

interface Props {
  offerId: string;
  options: Json;
  departmentId: string;
  weekStart: string;
}

/**
 * REQ §13.168 (c)/(d): a freed car with no single obvious use. The ranked options (one request, or several one after
 * another), the system's pick marked; the Sadran gives the car to one option, or ticks several for a discussion.
 */
export function FreedOfferOptions({ offerId, options, departmentId, weekStart }: Props) {
  const candidatesQuery = useFreedOfferCandidates(offerId);
  const award = useAwardFreedOptionMutation();
  const discuss = useDiscussFreedCandidatesMutation();
  const [showAll, setShowAll] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ kind: "give"; row: FreedOptionRow } | { kind: "discuss" } | null>(null);
  const candidates = candidatesQuery.data ?? [];
  const rows = freedOptionRows(options, candidates);
  const shown = showAll ? rows : rows.slice(0, SHOWN_OPTIONS);
  const open = openFreedCandidates(candidates);
  const namesOf = (ids: string[]) => ids.map((id) => candidates.find((c) => c.requestId === id)?.name ?? "").join(", ");
  const pending = award.isPending || discuss.isPending;

  return (
    <div className="space-y-3" data-testid={`freed-offer-options-${offerId}`}>
      <p className="font-medium">{he.sadranClaims.optionsTitle}</p>
      <ul className="space-y-2">
        {shown.map((row) => (
          <li key={row.key} className={`space-y-2 rounded-md border p-2 text-xs ${row.recommended ? "border-primary/60 bg-primary/5" : ""}`} data-testid="freed-option">
            {row.recommended ? <Badge className="text-[10px]">{he.sadranClaims.recommended}</Badge> : null}
            <div className="space-y-1">{row.people.map((person) => <PersonLine key={person.requestId} person={person} />)}</div>
            <Button size="sm" disabled={row.blocked || pending} onClick={() => setConfirm({ kind: "give", row })} data-testid="freed-option-give">
              {he.sadranClaims.give}
            </Button>
          </li>
        ))}
      </ul>
      {rows.length > SHOWN_OPTIONS ? (
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setShowAll((v) => !v)}>
          {showAll ? he.sadranClaims.fewerOptions
            : rows.length - SHOWN_OPTIONS === 1 ? he.sadranClaims.moreOptionOne
            : tv("sadranClaims.moreOptions", { count: String(rows.length - SHOWN_OPTIONS) })}
        </Button>
      ) : null}
      {open.length >= 2 ? (
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs font-medium">{he.sadranClaims.discussTitle}</p>
          <p className="text-xs text-muted-foreground">{he.sadranClaims.discussHint}</p>
          <ul className="space-y-1">
            {open.map((c) => (
              <li key={c.requestId} className="flex items-center gap-2 text-xs">
                <Checkbox
                  id={`discuss-${offerId}-${c.requestId}`}
                  checked={ticked.includes(c.requestId)}
                  onCheckedChange={(on) => setTicked((t) => (on ? [...t, c.requestId] : t.filter((id) => id !== c.requestId)))}
                  data-testid="freed-discuss-tick"
                />
                <label htmlFor={`discuss-${offerId}-${c.requestId}`}><PersonLine person={c} /></label>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="outline" disabled={ticked.length < 2 || pending} onClick={() => setConfirm({ kind: "discuss" })} data-testid="freed-discuss">
            {tv("sadranClaims.discuss", { count: String(ticked.length) })}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => { if (!o) setConfirm(null); }}
        title={confirm?.kind === "discuss" ? he.sadranClaims.discussTitle : he.sadranClaims.give}
        description={confirm?.kind === "give"
          ? [tv("sadranClaims.giveConfirm", { names: namesOf(confirm.row.requestIds) }),
             confirm.row.planB > 0 ? tv("sadranClaims.giveConfirmPlanB", { names: namesOf(confirm.row.people.filter((p) => p.planB).map((p) => p.requestId)) }) : ""].filter(Boolean).join(" ")
          : tv("sadranClaims.discussConfirm", { names: namesOf(ticked) })}
        onConfirm={() => {
          if (confirm?.kind === "give") {
            award.mutate({ offerId, requestIds: confirm.row.requestIds, departmentId, weekStart }, { onSuccess: () => toast.success(he.sadranClaims.given) });
          } else if (confirm?.kind === "discuss") {
            discuss.mutate({ offerId, requestIds: ticked, departmentId, weekStart }, { onSuccess: () => { setTicked([]); toast.success(he.sadranClaims.discussed); } });
          }
          setConfirm(null);
        }}
      />
    </div>
  );
}
