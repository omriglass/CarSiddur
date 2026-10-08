import { fetchExportLayout } from "@/features/rides/api";
import { fetchAllWeekRides, fetchLatestSiddurVersion, fetchWeekRequestsWithNames, type BoardRide, type SiddurVersionRow, type WeekRequestRow } from "../api";

export interface WeekExportData {
  departmentId: string;
  weekStart: string;
  requests: WeekRequestRow[];
  rides: BoardRide[];
  cars: { id: string; name: string; type?: string | null; status?: string | null }[];
  homeDestinationId?: string | null;
  boardStartTime?: string | null;
  publication: SiddurVersionRow | null;
}
export async function fetchWeekExport(departmentId: string, weekStart: string): Promise<WeekExportData> {
  const [requests, rides, layout, publication] = await Promise.all([
    fetchWeekRequestsWithNames(departmentId, weekStart), fetchAllWeekRides(departmentId, weekStart),
    fetchExportLayout(departmentId), fetchLatestSiddurVersion(departmentId, weekStart),
  ]);
  return { departmentId, weekStart, requests, rides, cars: layout.cars, homeDestinationId: layout.homeDestinationId, boardStartTime: layout.boardStartTime, publication };
}
