import { ChevronDown } from "lucide-react";

import { formatWeekRangeLabel } from "@/components/DateField";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n/he";

import type { ThisNextWeekResolution } from "../thisNextWeek";
import type { Week } from "../api";

interface WeekSwitcherTitleProps {
  resolution: ThisNextWeekResolution<Week>;
  activeWeekStart: string | undefined;
  onSelect: (weekStart: string) => void;
}

/**
 * Mobile siddur header title (UX_FLOWS.md member siddur "mobile header"):
 * the title *is* the week switcher, exactly two choices ("השבוע"/"שבוע הבא").
 * Whichever is missing from the (RLS-filtered) `weeks` list is shown
 * disabled rather than hidden, so the two options are always in the same
 * place. Hidden `>= md` — desktop keeps the plain title + week-chip strip.
 */
export function WeekSwitcherTitle({ resolution, activeWeekStart, onSelect }: WeekSwitcherTitleProps) {
  const { thisWeekStart, nextWeekStart, thisWeek, nextWeek } = resolution;
  const label =
    activeWeekStart === thisWeekStart ? t("siddur.thisWeek")
      : activeWeekStart === nextWeekStart ? t("siddur.nextWeek")
        : t("screen.siddur.title");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex min-h-11 items-center gap-1 text-start"
          data-testid="siddur-week-switcher"
        >
          <span className="flex flex-col items-start">
            <span className="text-lg font-semibold text-foreground">{label}</span>
            {activeWeekStart ? (
              <span className="text-xs text-muted-foreground" dir="ltr">{formatWeekRangeLabel(activeWeekStart)}</span>
            ) : null}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem
          disabled={!thisWeek}
          data-testid="siddur-week-option-this"
          onSelect={() => thisWeek && onSelect(thisWeek.week_start)}
        >
          <span className="flex flex-col">
            <span>{t("siddur.thisWeek")}</span>
            <span className="text-xs text-muted-foreground" dir="ltr">{formatWeekRangeLabel(thisWeekStart)}</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!nextWeek}
          data-testid="siddur-week-option-next"
          onSelect={() => nextWeek && onSelect(nextWeek.week_start)}
        >
          <span className="flex flex-col">
            <span>{t("siddur.nextWeek")}</span>
            <span className="text-xs text-muted-foreground" dir="ltr">{formatWeekRangeLabel(nextWeekStart)}</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
