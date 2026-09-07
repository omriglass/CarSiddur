import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/rpc";
import { fetchAllWeekRides, fetchLatestSiddurVersion, fetchWeekRequestsWithNames, type BoardRide, type SiddurVersionRow, type WeekRequestRow } from "../api";

export interface WeekExportData {
  departmentId: string;
  weekStart: string;
  requests: WeekRequestRow[];
  rides: BoardRide[];
  cars: { id: string; name: string }[];
  publication: SiddurVersionRow | null;
}
async function fetchExportCars(departmentId: string) {
  // Include retired cars so older weeks retain their car labels.
  const { data, error } = await supabase.from("cars").select("id, name").eq("department_id", departmentId);
  if (error) throw toAppError(error);
  return data ?? [];
}
export async function fetchWeekExport(departmentId: string, weekStart: string): Promise<WeekExportData> {
  const [requests, rides, cars, publication] = await Promise.all([
    fetchWeekRequestsWithNames(departmentId, weekStart), fetchAllWeekRides(departmentId, weekStart),
    fetchExportCars(departmentId), fetchLatestSiddurVersion(departmentId, weekStart),
  ]);
  return { departmentId, weekStart, requests, rides, cars, publication };
}
