// SD1 (REQ item 256, owner 2026-11-18/19, mockups https://claude.ai/artifact/V4fgeTNMeXcX2pSnPYnxHq): the ride's
// time constraints in one picture - "לפי אנשים" (default) or "לפי מסלול", the last choice remembered per device.
// Header: each way's hours and the route. Data: `rideTimes()` (../rideTimes.ts). While the stretches load (or when
// the ride has no way with two places) the stops view stands in.
import { Lock } from "lucide-react";
import { useState } from "react";

import { he, tv } from "@/i18n/he";
import type { RoutePoint } from "@/lib/rideRoute";
import { parseRideRoute } from "@/lib/rideRoute";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

import { useRideStretchesQuery } from "../hooks";
import type { RidePerson } from "../ridePeople";
import { rideTimes, type Actual, type Conflict, type Mark, type PersonRow, type RequestHours, type Stated } from "../rideTimes";
import type { ServedEntry } from "../servedOf";
import { RideStopsView } from "./RideStopsView";

type View = "people" | "route";
const VIEW_KEY = "carsiddur.rideDetails.view";

function readView(): View {
  try { return localStorage.getItem(VIEW_KEY) === "route" ? "route" : "people"; } catch { return "people"; }
}
function saveView(view: View): void {
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* per-device convenience only */ }
}

const hhmm = (iso: string) => formatTime(new Date(iso));
const shift = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

const fmt = (actual: Actual | null) => (actual ? `${actual.estimate ? "~" : ""}${hhmm(actual.at)}` : "");

function Time({ actual }: { actual: Actual | null }) {
  if (!actual) return null;
  return <span dir="ltr" className="tabular-nums">{actual.estimate ? "~" : ""}{hhmm(actual.at)}</span>;
}

/** A stated hour with no flexibility (owner 2026-11-19): blue, with a little lock, never the word "קבוע". */
const isFixed = (s: Stated) => s.early === 0 && s.late === 0;

function FixedTime({ iso }: { iso: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 font-semibold text-blue-700 dark:text-blue-300" data-testid="ride-details-fixed">
      <Lock className="size-3 shrink-0" aria-label={he.rideStops.fixed} />
      <span dir="ltr" className="tabular-nums">{hhmm(iso)}</span>
    </span>
  );
}

/** What the person asked: a fixed hour (lock), "09:00 · גמיש 15 דק׳", "גמיש 07:30–08:00". */
function Asked({ s }: { s: Stated }) {
  return isFixed(s) ? <FixedTime iso={s.at} /> : <>{askedText(s)}</>;
}

function askedText(s: Stated): string {
  if (s.early >= 1440 || s.late >= 1440) return tv("rideDetails.statedAnyTime", { time: hhmm(s.at) });
  if (s.anchor === "leave" && s.early > 0) return tv("rideDetails.statedRange", { from: hhmm(shift(s.at, -s.early)), to: hhmm(shift(s.at, s.late)) });
  return tv("rideDetails.statedFlex", { time: hhmm(s.at), n: String(s.late) });
}

function Tag({ s }: { s: Stated }) {
  if (!isFixed(s)) return <>{tagText(s)}</>;
  // "X: להגיע עד" / "X: לצאת ב־" and the hour in blue with the lock
  const words = tv(s.anchor === "arrive" ? "rideDetails.tagArrive" : "rideDetails.tagLeave", { name: s.name, time: "" }).trim();
  return <>{words}<FixedTime iso={s.at} /></>;
}

function tagText(s: Stated): string {
  if (s.anchor === "leave" && s.early > 0 && s.early < 1440 && s.late < 1440) {
    return tv("rideDetails.tagRange", { name: s.name, from: hhmm(shift(s.at, -s.early)), to: hhmm(shift(s.at, s.late)) });
  }
  const tag = tv(s.anchor === "arrive" ? "rideDetails.tagArrive" : "rideDetails.tagLeave", { name: s.name, time: hhmm(s.at) });
  if (s.early >= 1440 || s.late >= 1440) return tv("rideDetails.tagAnyTime", { tag });
  return s.late > 0 ? tv("rideDetails.tagFlex", { tag, n: String(s.late) }) : tag;
}

function markText(mark: Mark): string {
  if (mark.kind === "tight") return tv("rideDetails.tight", { n: String(mark.minutes) });
  if (mark.kind === "late") return tv("rideDetails.late", { n: String(mark.minutes) });
  // a conflict is spelled out on its own line under the block / card
  return mark.kind === "conflict" ? "✕" : he.rideDetails.ok;
}

function markClass(mark: Mark | null): string {
  if (!mark || mark.kind === "ok") return "text-muted-foreground";
  return mark.kind === "conflict" ? "font-semibold text-destructive" : "font-semibold text-amber-800 dark:text-amber-300";
}

function conflictText(c: Conflict): string {
  const who = (s: Stated) => (s.rideStart ? he.rideDetails.rideStart : s.name);
  return tv("rideDetails.conflictLine", { a: who(c.a), t1: hhmm(c.a.at), b: who(c.b), t2: hhmm(c.b.at) });
}

function ConflictLines({ conflicts }: { conflicts: readonly Conflict[] }) {
  return conflicts.map((c) => (
    <p key={`${c.a.id}|${c.b.id}`} className="text-xs font-semibold text-destructive" data-testid="ride-details-conflict">{conflictText(c)}</p>
  ));
}

function rowLabel(row: PersonRow): string {
  const key = ({ leave: "rideDetails.rowLeave", board: "rideDetails.rowBoard", arriveBy: "rideDetails.rowArriveBy", alight: "rideDetails.rowAlight", back: "rideDetails.rowBack" } as const)[row.kind];
  return tv(key, { place: row.place });
}

function roleText(role: "driver" | "rider" | "added", legs: "out" | "return" | "both"): string {
  const r = role === "driver" ? he.ride.driver : role === "added" ? he.rideDetail.person.roleAdded : he.rideDetail.person.roleRider;
  const l = legs === "both" ? he.rideDetail.person.legBoth : legs === "out" ? he.rideDetail.person.legOut : he.rideDetail.person.legReturn;
  return `${r} · ${l}`;
}

export interface RideDetailsViewProps {
  rideId: string | null;
  version: number | null;
  route: unknown;
  people: readonly RidePerson[];
  requests: readonly RequestHours[];
  startsAt: string | null;
  served?: readonly Pick<ServedEntry, "leg">[];
}

export function RideDetailsView({ rideId, version, route, people, requests, startsAt, served }: RideDetailsViewProps) {
  const [view, setView] = useState<View>(readView);
  const points: RoutePoint[] = parseRideRoute(route);
  const query = useRideStretchesQuery(rideId, version, points.length >= 2);
  const fallback = <RideStopsView rideId={rideId} version={version} route={route} people={people} served={served} />;
  if (!query.data) return fallback;
  const times = rideTimes({ points, stretches: query.data, people, requests, startsAt });
  if (!times.legs.length) return fallback;
  const choose = (next: View) => { setView(next); saveView(next); };

  return (
    <div className="space-y-3" data-testid="ride-details-view" data-view={view}>
      <div className="space-y-0.5">
        <p className="text-sm">
          {times.legs.map((span, index) => (
            <span key={span.leg}>
              {index ? " · " : ""}
              {span.leg === "out" ? he.rideRoute.out : he.rideRoute.return}{" "}
              <span dir="ltr" className="tabular-nums">{fmt(span.from)} → {fmt(span.to)}</span>
            </span>
          ))}
        </p>
        <p className="break-words text-xs text-muted-foreground">{tv("rideDetails.routeLine", { places: times.places.join(" · ") })}</p>
      </div>

      <div role="group" aria-label={he.rideDetails.viewLabel} className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        {(["people", "route"] as const).map((id) => (
          <button key={id} type="button" aria-pressed={view === id} onClick={() => choose(id)} data-testid={`ride-details-view-${id}`}
            className={cn("min-h-11 rounded-md text-sm", view === id ? "bg-background font-semibold shadow-sm" : "text-muted-foreground")}>
            {id === "people" ? he.rideDetails.byPeople : he.rideDetails.byRoute}
          </button>
        ))}
      </div>

      {view === "people" ? (
        <ul className="space-y-2">
          {times.people.map((person) => (
            <li key={person.key} className={cn("min-w-0 space-y-1.5 rounded-md border p-2", person.conflicts.length && "border-destructive")} data-testid="ride-details-person" data-person-key={person.key}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="break-words font-medium">{person.name}</span>
                <span className="text-xs text-muted-foreground">{roleText(person.role, person.legs)}</span>
              </div>
              {person.withNames.length ? <p className="break-words text-xs text-muted-foreground">{tv("rideDetail.person.withNames", { names: person.withNames.join(", ") })}</p> : null}
              <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
                <span />
                <span className="text-muted-foreground">{he.rideDetails.asked}</span>
                <span className="text-muted-foreground">{he.rideDetails.actual}</span>
                {person.rows.map((row) => (
                  <div key={`${row.leg}:${row.position}:${row.kind}`} className="contents" data-testid={`ride-details-row-${row.leg}-${row.position}`}>
                    <span className="break-words">{rowLabel(row)}</span>
                    <span className={row.stated ? "font-medium" : "text-muted-foreground"}>{row.stated ? <Asked s={row.stated} /> : he.rideDetails.none}</span>
                    <span className="break-words">
                      <Time actual={row.actual} />
                      {row.mark ? <span className={cn("ms-1", markClass(row.mark))} data-testid="ride-details-mark" data-mark={row.mark.kind}>{markText(row.mark)}</span> : null}
                    </span>
                  </div>
                ))}
              </div>
              <ConflictLines conflicts={person.conflicts} />
            </li>
          ))}
        </ul>
      ) : (
        <ol className="space-y-2">
          {times.route.map((card) => (
            <li key={`${card.leg}:${card.position}`} className="space-y-1" data-testid={`ride-details-place-${card.leg}-${card.position}`}>
              {card.first ? (
                <p className={cn("text-xs font-semibold text-muted-foreground", card.leg === "return" && "mt-2 border-t pt-2")}>
                  {card.leg === "out" ? he.rideRoute.out : he.rideRoute.return}
                </p>
              ) : null}
              <div className={cn("flex gap-3 rounded-md border p-2", card.conflicts.length && "border-destructive")}>
                <span className="w-14 shrink-0 text-sm font-semibold text-muted-foreground"><Time actual={card.actual} /></span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="break-words font-medium">
                    {card.name}
                    {card.isStop ? <span className="text-xs font-normal text-muted-foreground"> · {he.rideDetails.stop}</span> : null}
                  </p>
                  {card.on.length ? <p className="break-words text-xs text-emerald-800 dark:text-emerald-300">{tv("rideStops.on", { names: card.on.join(", ") })}</p> : null}
                  {card.off.length ? <p className="break-words text-xs text-rose-800 dark:text-rose-300">{tv("rideStops.off", { names: card.off.join(", ") })}</p> : null}
                  {card.tags.map((tag) => (
                    <p key={tag.stated.id} className="break-words text-xs" data-testid="ride-details-tag">
                      <span className="font-medium"><Tag s={tag.stated} /></span>
                      <span className={cn("ms-1", markClass(tag.mark))} data-mark={tag.mark.kind}>{markText(tag.mark)}</span>
                    </p>
                  ))}
                  {card.free != null ? <p className="text-xs text-muted-foreground">{card.free > 1 ? tv("rideStops.freeMany", { n: String(card.free) }) : card.free === 1 ? he.rideStops.freeOne : he.rideStops.full}</p> : null}
                  <ConflictLines conflicts={card.conflicts} />
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <p className="text-xs text-muted-foreground">
        <Lock className="inline size-3 text-blue-700 dark:text-blue-300" aria-label={he.rideStops.fixed} /> {he.rideDetails.legend}
      </p>
    </div>
  );
}
