import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { useProfile } from "@/features/auth/useProfile";

import { fetchClientErrors, fetchPreferenceStats, reportClientPreferences } from "./api";
import { collectDevicePreferences, deviceId, markReported, reportDue } from "./devicePreferences";
import { diagnosticsKeys } from "./keys";

export function useClientErrorsQuery() {
  return useQuery({
    queryKey: diagnosticsKeys.clientErrors(),
    queryFn: () => fetchClientErrors(),
    staleTime: 15_000,
  });
}

/** AN1 (REQ item 225): the admin's preference counts. */
export function usePreferenceStatsQuery() {
  return useQuery({ queryKey: diagnosticsKeys.preferenceStats(), queryFn: fetchPreferenceStats, staleTime: 60_000 });
}

/** AN1: an approved member's device reports its browser-only preferences, at most once a day; silent on failure. */
export function useReportDevicePreferences(): void {
  const approved = useProfile().data?.approval_status === "approved";
  useEffect(() => {
    if (!approved) return;
    const now = Date.now();
    if (!reportDue(now)) return;
    const version = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown";
    void reportClientPreferences(deviceId(), collectDevicePreferences(), version).then((ok) => { if (ok) markReported(now); });
  }, [approved]);
}
