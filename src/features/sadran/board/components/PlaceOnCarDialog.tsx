// R14M1: the car picker behind the unplaced card's "שבץ ברכב…" - the cars free at the request's own time.
import { FormDialog } from "@/components/FormDialog";
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";

import type { PlaceableCar } from "../placeOnCar";
import type { UnmetListItem } from "./UnmetList";

interface PlaceOnCarDialogProps {
  item: UnmetListItem;
  cars: readonly PlaceableCar[];
  onPick: (carId: string) => void;
  onClose: () => void;
}

export function PlaceOnCarDialog({ item, cars, onPick, onClose }: PlaceOnCarDialogProps) {
  return (
    <FormDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={tv("unmetCard.placeOnCarTitle", { name: item.request.requester_full_name ?? "" })}
      description={he.unmetCard.placeOnCarHint}
      onSubmit={onClose}
      footer={<Button type="button" variant="outline" className="min-h-11" onClick={onClose}>{he.common.cancel}</Button>}
    >
      {cars.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="place-on-car-none">{he.unmetCard.placeOnCarNone}</p>
      ) : (
        <ul className="space-y-2" data-testid="place-on-car-list">
          {cars.map((car) => (
            <li key={car.carId}>
              <Button type="button" variant="outline" className="min-h-11 w-full justify-start" data-testid="place-on-car-option" onClick={() => onPick(car.carId)}>{car.name}</Button>
            </li>
          ))}
        </ul>
      )}
    </FormDialog>
  );
}
