// REQ §13.203: the car is taken at the hours I want. Offer a free car when the caller knows one, else — only after
// talking — ask the drivers in the way to make room: return earlier, leave later, or give the ride up.
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { buildWaUrl } from "@/features/sadran/proposals/waLink";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { showErrorToast } from "@/lib/rpc";
import { formatTime } from "@/lib/time";

import {
  fetchMakeRoomOptions,
  fetchMakeRoomOptionsForRequest,
  type MakeRoomCar,
  type MakeRoomCut,
  type MakeRoomParty,
  type RideMove,
} from "./api";
import { useRequestMakeRoomMutation } from "./hooks";
import { defaultCuts, makeRoomChoices, makeRoomNames } from "./makeRoom";

const range = (from: string, to: string) => `⁦${formatTime(new Date(from))}–${formatTime(new Date(to))}⁩`;

interface Scope { departmentId: string; weekStart: string }

type Open =
  | (Scope & { kind: "move"; move: RideMove; freeCar: { name: string; use: () => void } | null; askable: boolean; parties: MakeRoomParty[] })
  | (Scope & { kind: "request"; requestId: string; cars: MakeRoomCar[] });

/** `onDone`: after the request was sent; `onClose`: whenever the dialog closes (sent, free car or back). */
export function useMakeRoom({ onDone, onClose }: { onDone?: () => void; onClose?: () => void } = {}) {
  const [open, setOpen] = useState<Open | null>(null);
  const [carId, setCarId] = useState<string | null>(null);
  const [cuts, setCuts] = useState<Record<string, MakeRoomCut>>({});
  const mutation = useRequestMakeRoomMutation();

  /** My ride dropped onto a taken slot. `freeCar`: another car free at those hours (the move goes there instead). */
  async function startMove(scope: Scope, move: RideMove, freeCar: { name: string; use: () => void } | null) {
    try {
      const options = await fetchMakeRoomOptions(move);
      setCuts(defaultCuts(options.parties));
      setOpen({ ...scope, kind: "move", move, freeCar, askable: options.askable, parties: options.parties });
    } catch (error) { showErrorToast(error); }
  }

  /** My new round trip went to the waiting list: returns false (nothing shown) when no car can be asked for. */
  async function startRequest(scope: Scope, requestId: string): Promise<boolean> {
    try {
      const cars = await fetchMakeRoomOptionsForRequest(requestId);
      const first = cars[0];
      if (!first) return false;
      setCarId(first.car_id);
      setCuts(defaultCuts(first.parties));
      setOpen({ ...scope, kind: "request", requestId, cars });
      return true;
    } catch { return false; }
  }

  const close = () => { setOpen(null); setCarId(null); onClose?.(); };
  const car = open?.kind === "request" ? open.cars.find((entry) => entry.car_id === carId) ?? open.cars[0] : null;
  const parties = open?.kind === "move" ? open.parties : car?.parties ?? [];
  const askable = open?.kind === "move" ? open.askable : !!car;
  const names = makeRoomNames(parties);

  function send() {
    if (!open) return;
    const target = open.kind === "move" ? { kind: "move" as const, move: open.move } : { kind: "request" as const, requestId: open.requestId, carId: car?.car_id ?? "" };
    mutation.mutate({ target, cuts: parties.map((party) => ({ rideId: party.ride_id, cut: cuts[party.ride_id] ?? "cancel" })),
      departmentId: open.departmentId, weekStart: open.weekStart }, {
      onSuccess: () => { close(); onDone?.(); toast.success(he.rideEditing.requested); },
    });
  }

  const element = (
    <ConfirmDialog
      open={!!open}
      onOpenChange={(next) => { if (!next) close(); }}
      title={open?.kind === "request" ? he.rideEditing.makeRoom.titleRequest : he.rideEditing.collisionTitle}
      description={askable ? tv("rideEditing.makeRoom.explain", { names }) : he.rideEditing.makeRoom.notAskable}
      confirmLabel={tv("rideEditing.makeRoom.send", { names })}
      cancelLabel={he.common.back}
      hideConfirm={!askable}
      loading={mutation.isPending}
      onConfirm={send}
      extraAction={open?.kind === "move" && open.freeCar ? (
        <Button variant="secondary" data-testid="make-room-free-car" onClick={() => { const use = open.freeCar?.use; close(); use?.(); }}>
          {tv("rideEditing.makeRoom.freeCar", { car: open.freeCar.name })}
        </Button>
      ) : undefined}
    >
      <div className="space-y-3" data-testid="make-room">
        {open?.kind === "request" && open.cars.length > 1 ? (
          <div className="flex flex-wrap gap-2" role="radiogroup">
            {open.cars.map((entry) => (
              <Button key={entry.car_id} size="sm" variant={entry.car_id === car?.car_id ? "default" : "outline"} role="radio"
                aria-checked={entry.car_id === car?.car_id}
                onClick={() => { setCarId(entry.car_id); setCuts(defaultCuts(entry.parties)); }}>
                {tv("rideEditing.makeRoom.carChoice", { car: entry.car_name })}
              </Button>
            ))}
          </div>
        ) : null}
        {askable ? parties.map((party) => (
          <fieldset key={party.ride_id} className="space-y-2 rounded-md border p-3" data-testid="make-room-party">
            <legend className="px-1 text-sm font-medium">
              {tv("rideEditing.makeRoom.party", { name: party.name, time: `${formatDayDate(party.starts_at)} ${range(party.starts_at, party.ends_at)}` })}
            </legend>
            {makeRoomChoices(party).map((choice) => (
              <label key={choice.cut} className="flex items-center gap-2 text-sm">
                <input type="radio" name={`cut-${party.ride_id}`} value={choice.cut} checked={(cuts[party.ride_id] ?? "cancel") === choice.cut}
                  onChange={() => setCuts((prev) => ({ ...prev, [party.ride_id]: choice.cut }))} />
                {choice.cut === "end" ? tv("rideEditing.makeRoom.returnEarlier", { time: formatTime(new Date(choice.at as string)), minutes: String(choice.minutes) })
                  : choice.cut === "start" ? tv("rideEditing.makeRoom.leaveLater", { time: formatTime(new Date(choice.at as string)), minutes: String(choice.minutes) })
                  : he.rideEditing.makeRoom.giveUp}
              </label>
            ))}
            {party.phone ? (
              <a className="inline-block text-sm text-primary underline" target="_blank" rel="noreferrer"
                href={buildWaUrl(party.phone, tv("rideEditing.makeRoom.whatsappText", { name: party.name, day: formatDayDate(party.starts_at), time: range(party.starts_at, party.ends_at) }))}>
                {tv("rideEditing.makeRoom.whatsapp", { name: party.name })}
              </a>
            ) : null}
          </fieldset>
        )) : null}
        {open?.kind === "request" ? <p className="text-sm text-muted-foreground">{he.rideEditing.makeRoom.waitlistNote}</p> : null}
      </div>
    </ConfirmDialog>
  );

  return { startMove, startRequest, element, pending: mutation.isPending };
}
