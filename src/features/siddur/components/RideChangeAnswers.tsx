import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useSession } from "@/features/auth/useSession";
import { he, tv } from "@/i18n/he";
import { formatInTimeZone } from "date-fns-tz";
import { TZ, formatTime } from "@/lib/time";
import { useRideChanges, useRespondRideChangeMutation, useCancelRideChangeMutation } from "../hooks";

export function RideChangeAnswers({ departmentId, weekStart, canManage = false }: { departmentId?: string; weekStart?: string; canManage?: boolean }) {
  const { session } = useSession();
  const changes = useRideChanges(departmentId, weekStart);
  const answer = useRespondRideChangeMutation();
  const cancel = useCancelRideChangeMutation();
  const mine = (changes.data ?? []).filter((change) => change.parties.some((p) => p.profile_id === session?.user.id && p.accepted === null));
  const outgoing = (changes.data ?? []).filter((change) => canManage || change.requester_id === session?.user.id);
  if (!mine.length && !outgoing.length) return null;
  return <section className="space-y-2" aria-label={he.rideEditing.answerTitle}>
    {mine.map((change) => <div key={change.id} className="space-y-3 rounded-md border border-primary/40 p-3" id={`change-${change.id}`}>
      <h2 className="font-medium">{he.rideEditing.answerTitle}</h2>
      <p className="text-sm">{tv("rideEditing.answerBody", { name: change.requester?.full_name ?? "", time: `${formatInTimeZone(change.starts_at, TZ, "d/M/yy HH:mm")}–${formatTime(new Date(change.ends_at))}` })}</p>
      <div className="flex flex-wrap gap-2">{[true, false].map((accept) => <Button key={String(accept)} variant={accept ? "default" : "outline"} disabled={answer.isPending} onClick={() => answer.mutate({ changeId: change.id, accept }, { onSuccess: () => toast.success(he.rideEditing.answered) })}>
        {accept ? he.rideEditing.accept : he.rideEditing.decline}
      </Button>)}</div>
    </div>)}
    {outgoing.map((change) => <div key={`outgoing-${change.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
      <span>{change.requester?.full_name} · {he.rideEditing.pending} · <span dir="ltr">{formatInTimeZone(change.starts_at, TZ, "d/M/yy HH:mm")}–{formatTime(new Date(change.ends_at))}</span></span>
      <Button variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(change.id)}>{he.rideEditing.cancelRequest}</Button>
    </div>)}
  </section>;
}
