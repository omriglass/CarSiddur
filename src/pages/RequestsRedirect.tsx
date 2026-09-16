import { Navigate, useLocation } from "react-router-dom";

/**
 * `/requests` → `/my`, preserving the query string (`?focus=<id>` in particular —
 * REQ §13 item 91, owner 2026-09-16, E3: one "my rides" screen). Kept as a thin redirect
 * rather than removing the route outright so old deep links/bookmarks keep working.
 */
export function RequestsRedirect() {
  const location = useLocation();
  return <Navigate to={`/my${location.search}`} replace />;
}
