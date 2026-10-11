import { Archive, ChevronDown } from "lucide-react";

import { formatWeekRangeLabel, todayInJerusalem } from "@/components/dateFieldDates";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isPastWeek, pastWeeks } from "@/features/siddur/pastWeeks";
import { resolveThisNextWeek } from "@/features/siddur/thisNextWeek";
import type { Week } from "@/features/siddur/api";
import { he, t } from "@/i18n/he";

/** How many past weeks the archive list offers (newest first). */
const MAX_ARCHIVE_WEEKS = 12;

interface MyWeekSwitcherProps {
  weeks: readonly Week[];
  activeWeekStart: string;
  onSelect: (weekStart: string) => void;
  /** `/my`: opens the separate archive page. Absent on the archive page itself, where the list is the past weeks. */
  onArchive?: () => void;
}

/**
 * Week switcher of the "my rides" week view (owner 2026-10-11): this week / next week plus a small "ארכיון" item that
 * opens the separate `/my/archive` page (past weeks, read-only). On that page (no `onArchive`) the menu lists the past
 * weeks instead. A week missing from the (RLS-filtered) list is shown disabled.
 */
export function MyWeekSwitcher({ weeks, activeWeekStart, onSelect, onArchive }: MyWeekSwitcherProps) {
  const today = todayInJerusalem();
  const { thisWeekStart, nextWeekStart, thisWeek, nextWeek } = resolveThisNextWeek(weeks, today);
  const past = pastWeeks(weeks.filter((w) => w.phase !== "upcoming"), today).slice(0, MAX_ARCHIVE_WEEKS);
  const activeIsPast = isPastWeek({ week_start: activeWeekStart, phase: weeks.find((w) => w.week_start === activeWeekStart)?.phase ?? "open" }, today);
  const label = activeWeekStart === thisWeekStart ? t("siddur.thisWeek")
    : activeWeekStart === nextWeekStart ? t("siddur.nextWeek")
      : activeIsPast ? he.siddur.archive : t("screen.home.title");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex min-h-11 items-center gap-1 text-start" data-testid="my-week-switcher">
          <span className="flex flex-col items-start">
            <span className="text-lg font-semibold text-foreground">{label}</span>
            <span className="text-xs text-muted-foreground" dir="ltr">{formatWeekRangeLabel(activeWeekStart)}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60dvh] overflow-y-auto">
        {onArchive ? (
          <>
            <DropdownMenuItem disabled={!thisWeek} data-testid="my-week-option-this" onSelect={() => thisWeek && onSelect(thisWeek.week_start)}>
              <span className="flex flex-col">
                <span>{t("siddur.thisWeek")}</span>
                <span className="text-xs text-muted-foreground" dir="ltr">{formatWeekRangeLabel(thisWeekStart)}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!nextWeek} data-testid="my-week-option-next" onSelect={() => nextWeek && onSelect(nextWeek.week_start)}>
              <span className="flex flex-col">
                <span>{t("siddur.nextWeek")}</span>
                <span className="text-xs text-muted-foreground" dir="ltr">{formatWeekRangeLabel(nextWeekStart)}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="my-week-option-archive" onSelect={onArchive}>
              <span className="flex items-center gap-2">
                <Archive className="size-4 text-muted-foreground" aria-hidden="true" />
                {he.siddur.archive}
              </span>
            </DropdownMenuItem>
          </>
        ) : past.length === 0 ? (
          <DropdownMenuItem disabled>{he.myWeek.noPastWeeks}</DropdownMenuItem>
        ) : past.map((week) => (
          <DropdownMenuItem key={week.week_start} data-testid="my-week-option-past" onSelect={() => onSelect(week.week_start)}>
            <span dir="ltr">{formatWeekRangeLabel(week.week_start)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
