import type { z } from "zod";

import type { placeWaitingResultSchema, waitingRequestSchema, waitlistGroupHoldSchema, waitlistGroupMemberSchema, waitlistGroupRowSchema } from "./schema";

export type WaitlistGroupMember = z.infer<typeof waitlistGroupMemberSchema>;
export type WaitlistGroup = z.infer<typeof waitlistGroupRowSchema>;
export type WaitlistGroupHold = z.infer<typeof waitlistGroupHoldSchema>;
export type WaitingRequest = z.infer<typeof waitingRequestSchema>;
export type PlaceWaitingResult = z.infer<typeof placeWaitingResultSchema>;
export type PlaceWaitingWarning = NonNullable<PlaceWaitingResult["warnings"]>[number];
export type PlaceWaitingBlock = NonNullable<PlaceWaitingResult["blocked"]>;
