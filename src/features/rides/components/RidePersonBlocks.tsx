// RD1: "מי ביקש מה" - one compact block per person on a shared ride (see ../ridePersonBlocks.ts).
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import { flexPairText, type PersonBlock } from "../ridePersonBlocks";

function roleLabel(block: PersonBlock): string {
  if (block.role === "driver") return he.ride.driver;
  return block.role === "added" ? he.rideDetail.person.roleAdded : he.rideDetail.person.roleRider;
}

function legLabel(leg: PersonBlock["leg"]): string | null {
  if (leg === "out") return he.rideDetail.person.legOut;
  if (leg === "return") return he.rideDetail.person.legReturn;
  if (leg === "both") return he.rideDetail.person.legBoth;
  return null;
}

function Time({ iso }: { iso: string }) {
  return <span dir="ltr">{formatTime(new Date(iso))}</span>;
}

export function RidePersonBlocks({ blocks }: { blocks: readonly PersonBlock[] }) {
  if (!blocks.length) return null;
  return (
    <div className="space-y-2" data-testid="ride-person-blocks">
      <span className="font-medium">{he.rideDetail.person.title}</span>
      <ul className="space-y-2">
        {blocks.map((block) => {
          const leg = legLabel(block.leg);
          const seats = block.seats
            ? [
                block.seats.adults ? tv("rideDetail.person.adults", { count: String(block.seats.adults) }) : "",
                block.seats.childSeats ? tv("rideDetail.person.childSeats", { count: String(block.seats.childSeats) }) : "",
                block.seats.boosters ? tv("rideDetail.person.boosters", { count: String(block.seats.boosters) }) : "",
                block.luggage ? he.rideDetail.person.luggage : "",
                block.tow ? he.rideDetail.person.tow : "",
              ].filter(Boolean)
            : [];
          const departFlex = block.flex ? flexPairText(block.flex.departEarly, block.flex.departLate) : "";
          const returnFlex = block.flex ? flexPairText(block.flex.returnEarly, block.flex.returnLate) : "";
          return (
            <li key={block.key} className="min-w-0 space-y-0.5 rounded-md border p-2" data-testid="ride-person-block">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="break-words font-medium">{block.name}</span>
                <span className="text-xs text-muted-foreground">{roleLabel(block)}{leg ? ` · ${leg}` : ""}</span>
              </div>
              {block.routeText ? <p className="break-words text-xs">{block.routeText}</p> : null}
              {block.returnStops.length ? <p className="break-words text-xs text-muted-foreground">{tv("rideDetail.person.stopsReturn", { stops: block.returnStops.join(", ") })}</p> : null}
              {block.departAt || block.returnAt ? (
                <p className="text-xs text-muted-foreground">
                  {he.rideDetail.person.asked}{" "}
                  {block.departAt ? <>{he.rideDetail.person.departAt}{" "}<Time iso={block.departAt} />{departFlex ? ` (${departFlex})` : ""}</> : null}
                  {block.departAt && block.returnAt ? " · " : ""}
                  {block.returnAt ? <>{he.rideDetail.person.returnAt}{" "}<Time iso={block.returnAt} />{returnFlex ? ` (${returnFlex})` : ""}</> : null}
                </p>
              ) : null}
              {seats.length ? <p className="text-xs text-muted-foreground">{seats.join(" · ")}</p> : null}
              {block.withNames.length ? <p className="break-words text-xs text-muted-foreground">{tv("rideDetail.person.withNames", { names: block.withNames.join(", ") })}</p> : null}
              {block.note ? <p className="whitespace-pre-wrap break-words text-xs"><span className="font-medium">{he.field.notes}: </span>{block.note}</p> : null}
              {block.differs.map((line) => (
                <p key={line} className="break-words text-xs text-amber-700 dark:text-amber-400" data-testid="ride-person-differs">{line}</p>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
