import { Link } from "react-router-dom";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { useDepartments } from "@/features/siddur/hooks";
import { he } from "@/i18n/he";

/**
 * `/admin/settings` (UX_FLOWS.md §5.10). The weekly-cycle fields themselves
 * (open/close/publish day+time, turnaround, day end, chauffeur dwell, detour
 * limits, closing reminders, auto-apply, board start) are edited per
 * department in the Departments screen's settings section (this file just
 * links there rather than duplicating the form).
 *
 * `app_settings` today only holds internal plumbing (`push_dispatch_url`,
 * `cron_secret`, `on_ride_cancelled_url`, `housekeeping_last_run` —
 * DATA_MODEL.md §3, `supabase/migrations/20260907091500_rpc.sql`), none of
 * it admin-facing config; this screen deliberately does not render that
 * table. See the stage 2c report: its RLS SELECT policy is `is_approved()`
 * (any approved member, not just admin), so a generic "app settings editor"
 * here would newly *display* `cron_secret` to non-admins in this app's own
 * network traffic — a pre-existing schema gap this stage flags rather than
 * works around (fixing it means editing `supabase/`, out of scope here).
 */
export function SettingsScreen() {
  const departmentsQuery = useDepartments();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <PageHeader title={he.screen.admin.settings} subtitle={he.adminSettings.subtitle} />

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{he.adminSettings.departmentSectionTitle}</h2>
        <div className="flex flex-col gap-2">
          {(departmentsQuery.data ?? []).map((d) => (
            <div key={d.id} className="flex items-center justify-between rounded-md border p-3">
              <span>{d.name}</span>
              <Button asChild size="sm" variant="outline">
                <Link to="/admin/departments">{he.adminCommon.edit}</Link>
              </Button>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{he.adminSettings.globalSectionTitle}</h2>
        <p className="text-sm text-muted-foreground">{he.adminSettings.empty}</p>
      </section>
    </div>
  );
}
