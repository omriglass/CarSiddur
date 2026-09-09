import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n/he";
import { paths } from "@/app/routes";

export interface AddRideFabProps {
  /**
   * Whether the currently relevant week (Home's current week / the Siddur's resolved week) is
   * `live` — a live week auto-approves a new request onto a specific car with no Sadran action
   * (REQ §8), so the FAB opens the quick "I want a car now" sheet (`onQuickRequest`) instead of
   * navigating to the full weekly form. Any other phase falls back to `/requests/new`.
   */
  isLiveWeek: boolean;
  /** Opens the quick-request sheet; only ever called when `isLiveWeek`. */
  onQuickRequest: () => void;
}

/**
 * Shared floating "+ בקשה חדשה" button (UX_FLOWS.md §2, "A floating '+' sits above the bar on
 * הסידור and הבקשות שלי") — used by both `SiddurPage` and `HomePage` so they can never drift
 * in icon/label/position again.
 */
export function AddRideFab({ isLiveWeek, onQuickRequest }: AddRideFabProps) {
  const className = "fixed bottom-20 end-4 z-30 gap-1.5 rounded-full shadow-lg md:bottom-6";
  const label = t("action.newRequest");

  if (isLiveWeek) {
    return (
      <Button type="button" size="lg" className={className} onClick={onQuickRequest}>
        <span aria-hidden="true" className="text-lg leading-none">+</span>
        {label}
      </Button>
    );
  }

  return (
    <Button asChild size="lg" className={className}>
      <Link to={paths.requests.new()}>
        <span aria-hidden="true" className="text-lg leading-none">+</span>
        {label}
      </Link>
    </Button>
  );
}
