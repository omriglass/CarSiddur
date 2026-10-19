import { PageHeader } from "@/components/PageHeader";
import { CHANGELOG } from "@/i18n/he.changelog";
import { he } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";

import type { ChangelogSection } from "@/features/changelog/changelog";

const SECTIONS: readonly ChangelogSection[] = ["users", "sadran", "admin"];

/**
 * REQ §13.139 (c): every changelog, newest first — every section for everyone (the inbox message is the one filtered by
 * role). Opened from the version button at the bottom of the profile page and from a "מה חדש" inbox message.
 */
export function ChangelogPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <PageHeader title={he.changelog.title} />
      <p className="text-sm text-muted-foreground">{he.changelog.intro}</p>
      <ol className="space-y-4" data-testid="changelog-list">
        {CHANGELOG.map((entry) => (
          <li key={entry.id} className="space-y-2 rounded-lg border p-4" data-testid="changelog-entry">
            <div>
              <h2 className="font-semibold">{entry.title}</h2>
              <p className="text-xs text-muted-foreground">{formatDayDate(`${entry.date}T12:00:00Z`)}</p>
            </div>
            {SECTIONS.filter((section) => entry[section].length > 0).map((section) => (
              <section key={section} className="space-y-1">
                <h3 className="text-sm font-medium">{he.changelog[section]}</h3>
                <ul className="list-disc space-y-1 ps-5 text-sm">
                  {entry[section].map((line) => <li key={line}>{line}</li>)}
                </ul>
              </section>
            ))}
          </li>
        ))}
      </ol>
    </div>
  );
}
