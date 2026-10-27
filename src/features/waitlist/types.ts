import type { z } from "zod";

import type { waitlistGroupHoldSchema, waitlistGroupMemberSchema, waitlistGroupRowSchema } from "./schema";

export type WaitlistGroupMember = z.infer<typeof waitlistGroupMemberSchema>;
export type WaitlistGroup = z.infer<typeof waitlistGroupRowSchema>;
export type WaitlistGroupHold = z.infer<typeof waitlistGroupHoldSchema>;
