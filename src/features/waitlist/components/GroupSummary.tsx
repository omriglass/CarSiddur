import { Fragment } from "react";

import { t, tv } from "@/i18n/he";

import { groupSummaryItems } from "../summary";
import type { WaitlistGroupMember } from "../types";

/** REQ §13.157: "שחר עם עמוס לבנימינה 09:00–13:00, או ענת לחיפה 10:00–14:00" — each time range kept whole and left-to-right. */
export function GroupSummary({ members, className }: { members: readonly WaitlistGroupMember[]; className?: string }) {
  return (
    <span className={className} data-testid="waitlist-group-summary">
      {groupSummaryItems(members).map((item, index) => (
        <Fragment key={item.requestId}>
          {index > 0 ? t("waitlist.summaryOr") : null}
          {tv("waitlist.summaryItem", { who: item.who, destination: item.destination })}{" "}
          <span dir="ltr" className="whitespace-nowrap">{item.start}–{item.end}</span>
        </Fragment>
      ))}
    </span>
  );
}
