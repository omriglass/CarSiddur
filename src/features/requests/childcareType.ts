// R9U7/R9F1: a child on the request suggests the childcare ride type ("ילדים", `ride_types.code
// = 'childcare'`) — but only while the member has not chosen a type themselves.
export interface RideTypeLike {
  id: string;
  code?: string | null;
}

export const CHILDCARE_CODE = "childcare";
const DEFAULT_CODE = "other";

export function childcareRideTypeId(rideTypes: readonly RideTypeLike[]): string | null {
  return rideTypes.find((type) => type.code === CHILDCARE_CODE)?.id ?? null;
}

/**
 * The ride type to switch to when a child is added, or `null` to leave the type alone: only for a
 * new request, only while the type is still the untouched default ("אחר"), never over a pick.
 */
export function shouldSuggestChildcare(input: {
  rideTypes: readonly RideTypeLike[];
  currentRideTypeId: string;
  touched: boolean;
  isNew: boolean;
}): string | null {
  if (!input.isNew || input.touched) return null;
  const current = input.rideTypes.find((type) => type.id === input.currentRideTypeId);
  if (!current || current.code !== DEFAULT_CODE) return null;
  const childcare = childcareRideTypeId(input.rideTypes);
  return childcare && childcare !== current.id ? childcare : null;
}
