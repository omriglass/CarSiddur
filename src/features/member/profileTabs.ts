/** `/profile?tab=` values (REQ §13.198); an unknown value opens the first tab. */
export const PROFILE_TABS = ["details", "prefs", "look", "notifications"] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

export function isProfileTab(value: string | null): value is ProfileTab {
  return PROFILE_TABS.some((id) => id === value);
}
