import { z } from "zod";

import { he } from "@/i18n/he";

/**
 * Israeli mobile numbers: `05X-XXXXXXX` (with or without the dash/spaces),
 * stored as E.164 (UX_FLOWS.md §3.2). The Hebrew error string lives in
 * `he.ts` (hard rule 3), not inlined here.
 */
const ISRAELI_MOBILE_RE = /^0(5\d)[- ]?(\d{7})$/;

export const phoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s+/g, ""))
  .refine((value) => ISRAELI_MOBILE_RE.test(value), he.onboarding.phoneInvalid)
  .transform((value) => {
    const match = value.match(ISRAELI_MOBILE_RE);
    // `refine` above already guarantees a match; this satisfies the type.
    if (!match) throw new Error("unreachable: phone already validated");
    return `+972${match[1]}${match[2]}`;
  });

export const onboardingPhoneSchema = z.object({
  phone: phoneSchema,
});

export type OnboardingPhoneInput = z.input<typeof onboardingPhoneSchema>;
