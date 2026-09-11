import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { he } from "@/i18n/he";
import { NotFoundPage } from "@/pages/NotFoundPage";

/** Extracts a support-facing message/stack from whatever `useRouteError()` returned. */
function describeError(error: unknown): string {
  if (isRouteErrorResponse(error)) {
    return `${error.status} ${error.statusText}${error.data ? `\n${JSON.stringify(error.data)}` : ""}`;
  }
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

/**
 * `errorElement` for the router (UX_FLOWS.md §2.3): a route-render exception
 * white-screens the PWA without this. A 404 (`isRouteErrorResponse` with
 * `status === 404`) renders the existing `NotFoundPage` instead of duplicating
 * its copy; anything else shows this minimal reload/home screen with the raw
 * error tucked into a collapsed `<details>` for support.
 */
export function ErrorScreen() {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundPage />;
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-4">
      <Card>
        <CardHeader>
          <CardTitle>{he.errorScreen.title}</CardTitle>
          <CardDescription>{he.errorScreen.body}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2">
            <Button onClick={() => window.location.reload()}>{he.errorScreen.reload}</Button>
            <Button variant="outline" asChild>
              <Link to="/">{he.errorScreen.backHome}</Link>
            </Button>
          </div>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">{he.errorScreen.detailsSummary}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-start" dir="ltr">
              {describeError(error)}
            </pre>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}
