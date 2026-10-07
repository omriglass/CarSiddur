import { Bug, RefreshCw } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";

import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { he, tv } from "@/i18n/he";
import { TZ } from "@/lib/time";

import { useClientErrorsQuery } from "../hooks";

/** Admin-only read-only list of the latest browser errors (E1, UX_FLOWS.md §5.13). */
export function ClientErrorsScreen() {
  const query = useClientErrorsQuery();
  const rows = query.data ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <PageHeader
        title={he.adminErrors.title}
        subtitle={he.adminErrors.subtitle}
        actions={
          <Button
            variant="outline"
            size="icon"
            className="size-11"
            aria-label={he.adminErrors.refresh}
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
          </Button>
        }
      />

      {query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} />
      ) : query.isPending ? (
        <p className="text-sm text-muted-foreground">{he.adminCommon.loading}</p>
      ) : rows.length === 0 ? (
        <EmptyState icon={Bug} message={he.adminErrors.empty} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{tv("adminErrors.count", { count: String(rows.length) })}</p>
          <ul className="flex flex-col gap-2" data-testid="client-errors-list">
            {rows.map((row) => (
              <li key={row.id}>
                <Card>
                  <CardContent className="flex flex-col gap-2 p-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span dir="ltr">{formatInTimeZone(new Date(row.created_at), TZ, "dd/MM/yyyy HH:mm:ss")}</span>
                      <span>
                        {he.adminErrors.user}: {row.profiles?.full_name ?? he.adminErrors.unknownUser}
                      </span>
                      {row.app_version ? (
                        <span>
                          {he.adminErrors.version}: <span dir="ltr">{row.app_version}</span>
                        </span>
                      ) : null}
                    </div>
                    <p className="break-words text-sm font-medium" dir="auto">
                      {row.message}
                    </p>
                    {row.url ? (
                      <p className="break-all text-xs text-muted-foreground">
                        {he.adminErrors.page}: <span dir="ltr">{row.url}</span>
                      </p>
                    ) : null}
                    {row.stack || row.user_agent ? (
                      <details className="text-xs text-muted-foreground">
                        <summary className="min-h-11 cursor-pointer py-2">{he.adminErrors.showStack}</summary>
                        {row.stack ? (
                          <pre className="whitespace-pre-wrap break-words text-start" dir="ltr">
                            {row.stack}
                          </pre>
                        ) : null}
                        {row.user_agent ? (
                          <p className="mt-2 break-words">
                            {he.adminErrors.device}: <span dir="ltr">{row.user_agent}</span>
                          </p>
                        ) : null}
                      </details>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
