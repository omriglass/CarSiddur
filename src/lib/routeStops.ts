// src/lib/routeStops.ts
//
// Shared reader for the multi-stop `stops` json shape several views/embeds expose
// (REQUIREMENTS §13.93 "Multi-stop rides", docs/ORIGINS_PLAN_2026-10.md §6.1/§6.4):
// `v_my_requests.stops`, `v_board_rides.served[].stops`,
// `v_request_template_suggestions.stops` all carry
// `[{ leg, position, place_id, place_text, name, eta }]`, already ordered by leg,
// then position. `eta` is null on a template suggestion (no committed request to
// compute a real one against). Pure/no React, no Supabase — safe for any feature
// to import (board, siddur, requests).
export interface RouteStop {
  leg: "out" | "return";
  position: number;
  placeId: string | null;
  placeText: string | null;
  name: string;
  eta: string | null;
}

function isLeg(value: unknown): value is "out" | "return" {
  return value === "out" || value === "return";
}

/** Parses one of the view json shapes above (already `unknown` at the API boundary) into ordered rows. */
export function parseRouteStops(raw: unknown): RouteStop[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((item): RouteStop[] => {
      if (!item || typeof item !== "object") return [];
      const o = item as Record<string, unknown>;
      if (!isLeg(o.leg)) return [];
      const placeText = typeof o.place_text === "string" ? o.place_text : null;
      return [
        {
          leg: o.leg,
          position: typeof o.position === "number" ? o.position : 0,
          placeId: typeof o.place_id === "string" ? o.place_id : null,
          placeText,
          name: typeof o.name === "string" && o.name ? o.name : (placeText ?? ""),
          eta: typeof o.eta === "string" ? o.eta : null,
        },
      ];
    })
    .sort((a, b) => a.leg.localeCompare(b.leg) || a.position - b.position);
}

/** Ordered names of one leg's stops only — `routeLabel()`'s out-stops, `/my` rows. */
export function routeStopNames(stops: readonly RouteStop[], leg: "out" | "return"): string[] {
  return stops
    .filter((s) => s.leg === leg)
    .map((s) => s.name)
    .filter((name) => name.trim() !== "");
}

/** Total stop count across both legs — the board/unmet "· N עצירות" marker (REQUIREMENTS §13.93 "Display"). */
export function totalStopCount(stops: readonly RouteStop[]): number {
  return stops.length;
}
