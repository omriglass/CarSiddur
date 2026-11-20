import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useRequestLinkProps } from "@/app/overlayState";
import { paths } from "@/app/routes";
import { Button } from "@/components/ui/button";
import { AskChatSheet } from "@/features/ask/components/AskChatSheet";
import { AskOrFormSheet } from "@/features/ask/components/AskOrFormSheet";
import { useAskOffered } from "@/features/ask/hooks";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useWeeks } from "@/features/siddur/hooks";
import { t } from "@/i18n/he";
import { cn } from "@/lib/utils";

import { newRequestButtonState } from "../newRequestButton";
import { RequestLink } from "./RequestLink";

const LABEL_KEY = {
  nextWeek: "newRequestButton.nextWeek",
  preparing: "newRequestButton.preparing",
  waitlistNextWeek: "newRequestButton.waitlistNextWeek",
  // Same label as the enabled `nextWeek` state — the button always reads as being about next
  // week, whether or not that week is open to request against yet (owner decision 2026-09-14).
  nextWeekNotOpenYet: "newRequestButton.nextWeek",
} as const;

interface NewRequestButtonProps {
  /** `fab`: the floating "+" button (`SiddurPage`/`HomePage`). `inline`: a plain sized button (e.g. an empty-state action). */
  variant: "fab" | "inline";
  className?: string;
}

/**
 * Shared three/four-state "בקשה חדשה" button (docs/TODO.md F2, owner decision 2026-09-14;
 * REQUIREMENTS §13.81). Computes its target week from the same `weeks` rows every other
 * "which week is next" decision reads (`useWeeks`, see `resolveWeekStart.ts`) — see
 * `newRequestButton.ts` for the state machine. Live-week quick requests from an empty board
 * slot / "car now" are a separate, unaffected entry point (owner A3).
 */
export function NewRequestButton({ variant, className }: NewRequestButtonProps) {
  const active = useActiveDepartment();
  const weeksQuery = useWeeks(active.departmentId);
  const state = newRequestButtonState(weeksQuery.data ?? []);
  const label = t(LABEL_KEY[state.kind]);
  // REQ item 258 (a): an opted-in member who has not hidden it gets the choice form / "לכתוב במילים".
  const askOffered = useAskOffered();
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const navigate = useNavigate();
  const linkProps = useRequestLinkProps();

  const fabClassName = cn("fixed bottom-20 end-4 z-30 gap-1.5 rounded-full shadow-lg md:bottom-6", className);

  if (state.kind === "preparing" || state.kind === "nextWeekNotOpenYet") {
    return (
      <Button
        type="button"
        size={variant === "fab" ? "lg" : "sm"}
        disabled
        aria-disabled="true"
        className={variant === "fab" ? cn(fabClassName, "opacity-60") : cn("opacity-60", className)}
      >
        {variant === "fab" ? <span aria-hidden="true" className="text-lg leading-none">+</span> : null}
        {label}
      </Button>
    );
  }

  // Waitlist states explicitly enter the same "you're on the waiting list" flow the siddur's
  // own waitlist button already uses (`waitlist=1`, REQ §13.66 / consistency decision 24) —
  // the underlying submit_request/try_auto_approve behavior is identical either way, this
  // only decides whether RequestForm shows the waiting-list banner up front.
  const to = paths.requests.new({
    week: state.weekStart,
    waitlist: state.kind === "waitlistNextWeek" ? true : undefined,
  });

  if (askOffered && active.departmentId) {
    const openForm = () => navigate(to, linkProps);
    return (
      <>
        <Button type="button" size={variant === "fab" ? "lg" : "sm"} className={variant === "fab" ? fabClassName : className}
          onClick={() => setChoiceOpen(true)} data-testid="new-request-button">
          {variant === "fab" ? <span aria-hidden="true" className="text-lg leading-none">+</span> : null}
          {label}
        </Button>
        <AskOrFormSheet open={choiceOpen} onOpenChange={setChoiceOpen}
          onForm={() => { setChoiceOpen(false); openForm(); }}
          onAsk={() => { setChoiceOpen(false); setChatOpen(true); }} />
        {/* Mounted per opening: a closed chat is over (REQ item 258 c — no resume). */}
        {chatOpen ? (
          <AskChatSheet open onOpenChange={setChatOpen} departmentId={active.departmentId}
            fallbackWeekStart={state.weekStart} onForm={openForm} />
        ) : null}
      </>
    );
  }

  return (
    <Button asChild size={variant === "fab" ? "lg" : "sm"} className={variant === "fab" ? fabClassName : className}>
      <RequestLink to={to}>
        {variant === "fab" ? <span aria-hidden="true" className="text-lg leading-none">+</span> : null}
        {label}
      </RequestLink>
    </Button>
  );
}
