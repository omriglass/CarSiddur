import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fleetKeys } from "@/features/fleet/queryKeys";

import { createRideType, fetchAllRideTypes, updateRideType, type RideTypeInsert, type RideTypeUpdate } from "./api";

const key = ["admin", "rideTypes"] as const;

export function useRideTypesAdmin() {
  const { departmentId } = useActiveDepartment();
  return useQuery({ queryKey: [...key, departmentId], enabled: !!departmentId, queryFn: () => fetchAllRideTypes(departmentId as string), staleTime: 60_000 });
}

export function useCreateRideTypeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RideTypeInsert) => createRideType(input),
    // the forms and the ride colours (RideTypeColorsProvider) read the fleet copy
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: key }); void queryClient.invalidateQueries({ queryKey: fleetKeys.rideTypes() }); },
  });
}

export function useUpdateRideTypeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: RideTypeUpdate }) => updateRideType(id, patch),
    // the forms and the ride colours (RideTypeColorsProvider) read the fleet copy
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: key }); void queryClient.invalidateQueries({ queryKey: fleetKeys.rideTypes() }); },
  });
}
