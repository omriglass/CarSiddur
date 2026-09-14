/** The six flexibility values every request field offers (REQUIREMENTS §5.3, UX_FLOWS.md §3.4). */
export const FLEX_VALUES = [0, 15, 30, 60, 120, "any"] as const;

export type FlexValue = (typeof FLEX_VALUES)[number];
