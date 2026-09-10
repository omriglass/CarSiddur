import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { paths } from "@/app/routes";
import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";
import { dateKey } from "@/lib/time";

import { fetchWaitlistGroups } from "../api";
import { waitlistKeys } from "../keys";

interface OpenWaitlistGroupButtonProps {
  departmentId: string;
  weekStart: string;
  requestId: string;
  /** Anchor instant for the request's day (`departAt`, falling back to `returnAt` for a `one_way_from` request). */
  day: string;
}

/**
 * "לדיון" action on a `WAITLISTED_CONTESTED` request card (`/requests`,
 * REQ §13.75): the group id isn't on `v_my_requests`, so this looks it up on
 * click (sharing the `useWaitlistGroupsQuery` cache) and navigates to the
 * siddur day, opening the resolution sheet when the group is still found —
 * otherwise it just opens the day (the group may already have been resolved
 * or cancelled by somebody else).
 */
export function OpenWaitlistGroupButton({ departmentId, weekStart, requestId, day }: OpenWaitlistGroupButtonProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const groups = await queryClient.fetchQuery({
        queryKey: waitlistKeys.groups(departmentId, weekStart),
        queryFn: () => fetchWaitlistGroups(departmentId, weekStart),
      });
      const group = groups.find((g) => g.members.some((member) => member.request_id === requestId));
      navigate(paths.siddur({ dept: departmentId, week: weekStart, day: dateKey(day), groupId: group?.id }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button size="sm" variant="outline" disabled={loading} onClick={() => void handleClick()}>
      {he.waitlist.openGroup}
    </Button>
  );
}
