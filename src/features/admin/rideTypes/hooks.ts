import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createRideType, fetchAllRideTypes, updateRideType, type RideTypeInsert, type RideTypeUpdate } from "./api";

const key = ["admin", "rideTypes"] as const;

export function useRideTypesAdmin() {
  return useQuery({ queryKey: key, queryFn: fetchAllRideTypes, staleTime: 60_000 });
}

export function useCreateRideTypeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RideTypeInsert) => createRideType(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useUpdateRideTypeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: RideTypeUpdate }) => updateRideType(id, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
}
