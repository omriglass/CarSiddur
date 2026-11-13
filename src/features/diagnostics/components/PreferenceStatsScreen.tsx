import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { he, tv } from "@/i18n/he";
import type { NotificationEvent } from "@/lib/enums";

import { usePreferenceStatsQuery } from "../hooks";
import { asCounts, asNumber } from "../preferenceStats";

const PROFILE_FLAGS = [
  "classicForm", "weekView", "doesNotDrive", "pushOnRideEditsOff", "driverReminderOn", "driverReminderOff",
  "mutedAny", "withPush", "defaultOrigin", "preferredCar",
] as const;

/** AN1 (REQ item 225): admin-only counts of members' profile and device preferences. Counts only, no names. */
export function PreferenceStatsScreen() {
  const query = usePreferenceStatsQuery();
  const stats = query.data ?? {};
  const total = asNumber(stats.members);
  const device = (stats.device && typeof stats.device === "object" ? stats.device : {}) as Record<string, unknown>;
  const eventLabel = (event: string) => (he.notif as Partial<Record<NotificationEvent, string>>)[event as NotificationEvent] ?? event;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <PageHeader title={he.adminPrefs.title} subtitle={he.adminPrefs.subtitle} />
      {query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} />
      ) : query.isPending ? (
        <p className="text-sm text-muted-foreground">{he.adminCommon.loading}</p>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">{he.adminPrefs.profileTitle}</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm" data-testid="prefs-profile">
              <ul className="space-y-1">
                {PROFILE_FLAGS.map((key) => (
                  <li key={key} className="flex justify-between gap-3">
                    <span>{he.adminPrefs[key]}</span>
                    <span className="tabular-nums text-muted-foreground">{tv("adminPrefs.ofMembers", { count: String(asNumber(stats[key])), total: String(total) })}</span>
                  </li>
                ))}
              </ul>
              <CountList title={he.adminPrefs.homeWeek} counts={asCounts(stats.homeWeek)} label={(value) => homeWeekLabel(value)} />
              <CountList title={he.adminPrefs.muted} counts={asCounts(stats.muted)} label={eventLabel} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{he.adminPrefs.deviceTitle}</CardTitle>
              <p className="text-xs text-muted-foreground">
                {tv("adminPrefs.devices", { devices: String(asNumber(stats.devices)), members: String(asNumber(stats.deviceMembers)) })}
              </p>
            </CardHeader>
            <CardContent className="space-y-3 text-sm" data-testid="prefs-device">
              {Object.keys(device).length === 0 ? <p className="text-muted-foreground">{he.adminPrefs.noDevices}</p> : null}
              {Object.keys(device).sort().map((key) => (
                <CountList key={key} title={he.adminPrefs.deviceKey[key] ?? key} counts={asCounts(device[key])} label={valueLabel} />
              ))}
              <CountList title={he.adminPrefs.versions} counts={asCounts(stats.versions)} label={(value) => value} ltr />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function homeWeekLabel(value: string): string {
  return value === "live" ? he.profileExtra.homeWeekLive : value === "open" ? he.profileExtra.homeWeekOpen : he.profileExtra.homeWeekAuto;
}

function valueLabel(value: string): string {
  return value === "true" ? he.adminPrefs.yes : value === "false" ? he.adminPrefs.no : value;
}

function CountList({ title, counts, label, ltr = false }: { title: string; counts: [string, number][]; label: (value: string) => string; ltr?: boolean }) {
  if (counts.length === 0) return null;
  return (
    <div>
      <p className="font-medium">{title}</p>
      <ul className="space-y-0.5 ps-3">
        {counts.map(([value, count]) => (
          <li key={value} className="flex justify-between gap-3">
            <span dir={ltr ? "ltr" : undefined}>{label(value)}</span>
            <span className="tabular-nums text-muted-foreground">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
