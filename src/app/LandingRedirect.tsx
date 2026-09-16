import { Navigate } from "react-router-dom";

import { readLandingPath } from "./landing";

/** `/` → the last opened main page (siddur or my rides), the same for every role (REQ §13.87). */
export function LandingRedirect() {
  return <Navigate to={readLandingPath()} replace />;
}
