// REQ item 258 (a), owner 2026-11-20: a chat-icon button on /my's top row opens the chat directly (for a question about
// my rides as much as for a new one). Shown only to a member the chat is offered to; greyed out when the probe says the
// service is unavailable. Mounted per opening, like "+": closing ends the conversation.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { MessageCircle } from "lucide-react";

import { useRequestLinkProps } from "@/app/overlayState";
import { paths } from "@/app/routes";
import { Button } from "@/components/ui/button";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { newRequestButtonState } from "@/features/requests/newRequestButton";
import { useWeeks } from "@/features/siddur/hooks";
import { he } from "@/i18n/he";

import { useAskOffered, useAskProbe } from "../hooks";
import { AskChatSheet } from "./AskChatSheet";

export function AskChatButton() {
  const active = useActiveDepartment();
  const offered = useAskOffered();
  const probe = useAskProbe(offered);
  const weeksQuery = useWeeks(active.departmentId);
  const navigate = useNavigate();
  const linkProps = useRequestLinkProps();
  const [open, setOpen] = useState(false);
  if (!offered || !active.departmentId || !active.canSubmit) return null;

  const state = newRequestButtonState(weeksQuery.data ?? []);
  const weekStart = "weekStart" in state ? state.weekStart : undefined;
  const unavailable = probe.data ? !probe.data.available : probe.isError;
  const label = unavailable ? `${he.ask.chatTitle} · ${he.ask.unavailable}` : he.ask.chatTitle;

  return (
    <>
      <Button type="button" variant="outline" size="icon" aria-label={label} title={label} disabled={unavailable}
        onClick={() => setOpen(true)} data-testid="ask-chat-button">
        <MessageCircle className="size-4" />
      </Button>
      {open ? (
        <AskChatSheet open onOpenChange={setOpen} departmentId={active.departmentId} fallbackWeekStart={weekStart}
          onForm={() => navigate(paths.requests.new({ week: weekStart }), linkProps)} />
      ) : null}
    </>
  );
}
