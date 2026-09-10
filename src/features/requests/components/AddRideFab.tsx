import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n/he";
import { paths } from "@/app/routes";

/**
 * Shared floating "+ בקשה חדשה" button (UX_FLOWS.md §2, "A floating '+' sits above the bar on
 * הסידור and הבקשות שלי") — used by both `SiddurPage` and `HomePage` so they can never drift
 * in icon/label/position again.
 *
 * It is a non-specific entry point, so it always links to `/requests/new`, which `resolveWeekStart`
 * resolves to the open week, or — when none is open — the next upcoming solving/published week,
 * or finally this week (REQ §13.74). "I want a car now" is the separate `CarNowButton`.
 */
export function AddRideFab() {
  return (
    <Button asChild size="lg" className="fixed bottom-20 end-4 z-30 gap-1.5 rounded-full shadow-lg md:bottom-6">
      <Link to={paths.requests.new()}>
        <span aria-hidden="true" className="text-lg leading-none">+</span>
        {t("action.newRequest")}
      </Link>
    </Button>
  );
}
