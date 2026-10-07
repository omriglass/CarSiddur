import { useQuery } from "@tanstack/react-query";

import { fetchClientErrors } from "./api";
import { diagnosticsKeys } from "./keys";

export function useClientErrorsQuery() {
  return useQuery({
    queryKey: diagnosticsKeys.clientErrors(),
    queryFn: () => fetchClientErrors(),
    staleTime: 15_000,
  });
}
