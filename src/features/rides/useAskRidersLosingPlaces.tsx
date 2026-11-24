// Silent drops item 3 (owner 2026-11-24): before a change takes a rider's get-on / off place off the ride's route,
// the person making it is asked (the rider is told by the server once it happens). The check never blocks a change:
// when it cannot be made, the change goes ahead as before.
import { useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { he, tv } from "@/i18n/he";

import { fetchRidersLosingPlaces, type RemovedRoutePoint } from "./api";
import { losingPlacesText } from "./offRoute";

export function useAskRidersLosingPlaces() {
  const [ask, setAsk] = useState<{ names: string; places: string } | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  function settle(ok: boolean) {
    resolver.current?.(ok);
    resolver.current = null;
    setAsk(null);
  }

  /** true = go ahead (nobody loses a place, or the person said yes); `load` asks the server who would. */
  async function confirmLoaded(load: () => Promise<{ name: string; place: string }[]>): Promise<boolean> {
    let rows: { name: string; place: string }[];
    try { rows = await load(); } catch { return true; }
    if (rows.length === 0) return true;
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setAsk(losingPlacesText(rows));
    });
  }

  /** The same for one ride and the route points a change takes out of it. */
  function confirmRidersLosingPlaces(rideId: string | null | undefined, removed: readonly RemovedRoutePoint[]): Promise<boolean> {
    if (!rideId || removed.length === 0) return Promise.resolve(true);
    return confirmLoaded(() => fetchRidersLosingPlaces(rideId, removed));
  }

  const dialog = (
    <ConfirmDialog
      open={!!ask}
      onOpenChange={(open) => { if (!open) settle(false); }}
      title={ask ? tv("offRoute.askTitle", { place: ask.places }) : ""}
      description={ask ? tv("offRoute.askBody", { names: ask.names, place: ask.places }) : ""}
      confirmLabel={he.offRoute.askConfirm}
      onConfirm={() => settle(true)}
    />
  );
  return { confirmRidersLosingPlaces, dialog };
}
