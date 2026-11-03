import { CarFront } from "lucide-react";
import { Link } from "react-router-dom";

import { paths } from "@/app/routes";
import { StatusBadge } from "@/components/StatusBadge";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Car } from "@/features/fleet/api";
import { RequestLink } from "@/features/requests/components/RequestLink";
import { he, tv } from "@/i18n/he";

/**
 * One car on "my rides" (/my): a car I am responsible for or my own private car. Tapping it offers
 * "add a ride on this car" (the request form with the car chosen: my private car takes a round trip
 * directly, a shared car is a preferred car under the normal rules) and the car's own page
 * (owner 2026-11-03, REQ §13.182).
 */
export function HomeCarCard({ car, addRideTo, checklistPrompt }: {
  car: Pick<Car, "id" | "name" | "license_plate" | "status">;
  /** `paths.requests.new(...)` with the car; omitted when the member cannot file requests. */
  addRideTo?: string;
  checklistPrompt?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="block w-full text-start" aria-label={tv("carPage.homeCarMenuLabel", { name: car.name })} data-testid={`home-car-${car.id}`}>
          <Card className="bg-gradient-card shadow-card transition-smooth hover:shadow-elegant">
            <CardContent className="flex items-center justify-between gap-2 p-3 text-sm">
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <CarFront className="size-5" aria-hidden="true" />
                </span>
                <div>
                  <p className="font-medium">{car.name}</p>
                  <p className="text-xs text-muted-foreground" dir="ltr">{car.license_plate}</p>
                  {checklistPrompt ? (
                    <p className="text-xs font-medium text-primary" data-testid="home-checklist-prompt">{he.carChecklist.promptCard}</p>
                  ) : null}
                </div>
              </div>
              <StatusBadge kind="car" status={car.status} />
            </CardContent>
          </Card>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {addRideTo ? (
          <DropdownMenuItem asChild>
            <RequestLink to={addRideTo}>{he.carPage.homeCarAddRide}</RequestLink>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem asChild>
          <Link to={paths.car(car.id)}>{he.carPage.homeCarOpenPage}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
