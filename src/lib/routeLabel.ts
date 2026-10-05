// One-line route label for copy that the browser renders itself (the proposal composer's
// WhatsApp templates, REQ §13.93) — the TS twin of SQL `route_label()`/`request_route_label()`,
// which render the seeded `text_fragments` rows `route.*` with the same wording (`he.route.*`).
// The origin is named only when it is not the department home.
import { tv } from "@/i18n/he";

export interface RouteLabelInput {
  destination: string;
  /** Origin place name or free text; ignored when `originIsHome`. */
  origin?: string | null;
  originIsHome: boolean;
  /** Names of the stops on the way out, in order (multi-stop rides). */
  stops?: readonly string[];
}

export function routeLabel({ destination, origin, originIsHome, stops = [] }: RouteLabelInput): string {
  const named = stops.filter((stop) => stop.trim() !== "");
  const showOrigin = !originIsHome && !!origin?.trim();
  if (named.length) {
    const vars = { origin: origin ?? "", destination, stops: named.join(", ") };
    return showOrigin ? tv("route.via", vars) : tv("route.toVia", vars);
  }
  return showOrigin ? tv("route.fromTo", { origin: origin ?? "", destination }) : tv("route.to", { destination });
}
