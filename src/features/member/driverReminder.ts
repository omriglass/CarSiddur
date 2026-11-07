// REQ §13.191 (DR2): after "אני אקח" / "אני אנהג" a member who never answered is asked "להזכיר לך 30 דקות לפני היציאה?";
// the answer is the profile switch `profiles.driver_reminder` (null = not asked yet, counts as on).
// `DriverReminderHost` (mounted in main.tsx) shows the one dialog.
import { useProfile, useUpdateProfileMutation } from "@/features/auth/useProfile";

type Asker = () => Promise<boolean>;
let hostAsker: Asker | null = null;

/** `DriverReminderHost` registers the dialog here (and clears it on unmount). */
export function registerDriverReminderAsker(asker: Asker | null): void {
  hostAsker = asker;
}

/** After volunteering to drive: asks once, while the member has not answered yet, and stores the answer. */
export function useAskDriverReminder(): () => Promise<void> {
  const profileQuery = useProfile();
  const updateProfile = useUpdateProfileMutation();
  return async () => {
    if (!hostAsker || !profileQuery.data || profileQuery.data.driver_reminder != null) return;
    const accepted = await hostAsker();
    updateProfile.mutate({ driver_reminder: accepted });
  };
}
