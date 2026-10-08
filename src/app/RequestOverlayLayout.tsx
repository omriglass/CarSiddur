import { Suspense } from "react";
import { Outlet, Route, Routes, useLocation } from "react-router-dom";

import { overlayBackgroundPath } from "./overlayState";
import { HomePage } from "@/pages/HomePage";
import { SiddurPage } from "./lazyPages";
import { useProfile } from "@/features/auth/useProfile";

/**
 * Layout route of `/requests/new` and `/requests/:id/edit`. For the sentence layout it renders the
 * page the member came from (siddur or `/my`, `requestOverlay.ts`) and the request page's own
 * overlay (`<Outlet />`) on top of it; the classic layout (and the moment before the profile has
 * loaded) is the plain full page, exactly as before (UX_FLOWS §3.4a).
 */
export function RequestOverlayLayout() {
  const profile = useProfile();
  const location = useLocation();
  const overlay = !!profile.data && !profile.data.classic_request_form;
  if (!overlay) return <Outlet />;
  return (
    <>
      <Suspense fallback={null}>
        <Routes location={overlayBackgroundPath(location.state)}>
          <Route path="/my" element={<HomePage />} />
          <Route path="/siddur/:dept/:week" element={<SiddurPage />} />
          <Route path="/siddur/:dept" element={<SiddurPage />} />
          <Route path="*" element={<SiddurPage />} />
        </Routes>
      </Suspense>
      <Outlet />
    </>
  );
}
