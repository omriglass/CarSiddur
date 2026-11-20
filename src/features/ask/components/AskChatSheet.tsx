// REQ item 258 (c, d), UX_FLOWS §3.4b: the chat. The member's messages are bubbles; every answer is built by the app
// from the checked draft (a card, a question with chips, ride chips, "לא הבנתי") — never the model's own prose. Nothing
// changes in the siddur here: a new request / an edit opens the regular form filled in, a cancel opens the existing
// cancel confirmation. Closing ends the conversation.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SendHorizontal } from "lucide-react";

import { useRequestLinkProps } from "@/app/overlayState";
import { paths } from "@/app/routes";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PortalSheetContent } from "@/components/PortalSheetContent";
import { Button } from "@/components/ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { he } from "@/i18n/he";
import { useDestinations } from "@/features/fleet/hooks";
import { cn } from "@/lib/utils";

import { withAssumedReturn, type TravelLookup } from "../assumedReturn";
import { AskTurnError, finishAskConversation, markAskTurn, sendAskTurn, type AskOutcome } from "../api";
import { buildDraftCard, rideChoices, rideLabel, type CardQuestion } from "../draftCard";
import { weekStartOfDay } from "../draftToForm";
import { useAckAskDisclaimerMutation, useAskAccess } from "../hooks";
import type { AskDraft, AskFormHandoff, AskTurnResult } from "../types";
import { AskDraftCardView } from "./AskDraftCardView";
import { AskFindView } from "./AskFindView";

type Entry =
  | { kind: "user"; text: string }
  | { kind: "answer"; result: AskTurnResult; previous: AskDraft | null }
  | { kind: "failed" };

export function AskChatSheet({ open, onOpenChange, departmentId, fallbackWeekStart, onForm }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  departmentId: string;
  /** The week "+" would open the form on, for a draft with no day yet. */
  fallbackWeekStart: string | undefined;
  /** "מילוי טופס" after a failure: the regular form, as "+" would open it. */
  onForm: () => void;
}) {
  const navigate = useNavigate();
  const linkProps = useRequestLinkProps();
  const access = useAskAccess();
  const ack = useAckAskDisclaimerMutation();
  const destinations = useDestinations(departmentId);
  const travel: TravelLookup = (name) => destinations.data?.find((d) => d.name === name)?.travel_minutes ?? null;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AskDraft | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [thumbs, setThumbs] = useState<Set<string>>(new Set());
  const endedRef = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [entries]);

  const needsDisclaimer = open && !!access.data && !access.data.disclaimerAckAt;

  function end(outcome: AskOutcome) {
    if (conversationId && !endedRef.current) {
      endedRef.current = true;
      void finishAskConversation(conversationId, outcome).catch(() => {});
    }
  }
  function close(outcome: AskOutcome = "closed") {
    end(outcome);
    onOpenChange(false);
  }

  async function send(message: string, override?: AskDraft | null) {
    const trimmed = message.trim();
    if (!trimmed || sending) return;
    setEntries((list) => [...list, { kind: "user", text: trimmed }]);
    setText("");
    setSending(true);
    const previous = override ?? draft;
    try {
      const result = await sendAskTurn({ departmentId, message: trimmed, conversationId, draft: previous });
      setConversationId(result.conversation_id);
      setDraft(result.draft);
      setEntries((list) => [...list, { kind: "answer", result, previous }]);
      // A cancel aimed at one ride goes straight to that request's own cancel confirmation.
      if (result.draft.intent === "cancel_request" && result.draft.target_ride) openCancel(result, result.draft.target_ride);
    } catch (error) {
      if (error instanceof AskTurnError && error.conversationId) setConversationId(error.conversationId);
      setEntries((list) => [...list, { kind: "failed" }]);
    } finally {
      setSending(false);
    }
  }

  function handoff(result: AskTurnResult, current: AskDraft, summary: string): AskFormHandoff {
    return { conversationId: result.conversation_id, draft: current, people: result.people, summary };
  }
  function toForm(result: AskTurnResult, current: AskDraft, summary: string) {
    endedRef.current = true;
    void finishAskConversation(result.conversation_id, "to_form").catch(() => {});
    const state = { ...linkProps.state, ask: handoff(result, current, summary) };
    if (current.intent === "edit_request" && current.target_ride) {
      const requestId = result.refs[current.target_ride];
      if (requestId) navigate(paths.requests.edit(requestId), { state, replace: linkProps.replace });
    } else {
      const week = current.date ? weekStartOfDay(current.date) : fallbackWeekStart;
      navigate(paths.requests.new({ week }), { state, replace: linkProps.replace });
    }
    onOpenChange(false);
  }
  function openCancel(result: AskTurnResult, ref: string) {
    const requestId = result.refs[ref];
    if (!requestId) return;
    endedRef.current = true;
    void finishAskConversation(result.conversation_id, "to_form").catch(() => {});
    navigate(paths.my(requestId, { cancel: true }));
    onOpenChange(false);
  }

  /** Find a ride → "+ נוסע/ת": that ride on the siddur, where the member adds themselves. */
  function openRide(result: AskTurnResult, rideId: string, week: string, day: string) {
    endedRef.current = true;
    void finishAskConversation(result.conversation_id, "to_form").catch(() => {});
    navigate(paths.siddur({ dept: departmentId, week, rideId, day }));
    onOpenChange(false);
  }

  const lastAnswerIndex = entries.map((e) => e.kind).lastIndexOf("answer");
  const latest = entries[lastAnswerIndex];
  const placeholder = entries.length === 0 || latest?.kind !== "answer" ? he.ask.placeholderEmpty
    : latest.result.draft.intent === "find_ride" ? he.ask.placeholderFind : he.ask.placeholderCard;

  return (
    <>
      <Sheet open={open && !needsDisclaimer} onOpenChange={(next) => { if (!next) close("closed"); }}>
        <PortalSheetContent side="bottom" className="flex h-[92dvh] flex-col gap-0 p-0" data-testid="ask-chat-sheet">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle>{he.ask.chatTitle}</SheetTitle>
            <SheetDescription className="sr-only">{he.ask.footer}</SheetDescription>
          </SheetHeader>
          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3" data-testid="ask-messages">
            {entries.length === 0 ? (
              <div className="flex flex-wrap gap-2">
                {he.ask.examples.map((example) => (
                  <Button key={example} type="button" size="sm" variant="outline" className="h-auto whitespace-normal py-1.5 text-start"
                    onClick={() => void send(example)}>{example}</Button>
                ))}
              </div>
            ) : null}
            {entries.map((entry, index) => {
              if (entry.kind === "user") {
                return <p key={index} className="ms-auto w-fit max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground" data-testid="ask-user-message">{entry.text}</p>;
              }
              if (entry.kind === "failed") {
                return (
                  <div key={index} className="space-y-2 rounded-lg border p-3 text-sm" data-testid="ask-failed">
                    <p>{he.ask.failed}</p>
                    {index === entries.length - 1 ? <Button type="button" size="sm" onClick={() => { close("closed"); onForm(); }}>{he.ask.fillForm}</Button> : null}
                  </div>
                );
              }
              return (
                <AnswerView key={index} entry={entry} active={index === lastAnswerIndex && !sending} travel={travel} departmentId={departmentId}
                  onOpenRide={(rideId, week, day) => openRide(entry.result, rideId, week, day)}
                  thumbsDown={!!entry.result.turn_id && thumbs.has(entry.result.turn_id)}
                  onThumbsDown={() => {
                    const turnId = entry.result.turn_id;
                    if (!turnId) return;
                    setThumbs((set) => new Set(set).add(turnId));
                    void markAskTurn(turnId, true).catch(() => {});
                  }}
                  onSend={(message, override) => void send(message, override)}
                  onLocalChange={(next) => {
                    setDraft(next);
                    setEntries((list) => list.map((e, i) => (i === index && e.kind === "answer" ? { ...e, previous: e.result.draft, result: { ...e.result, draft: next } } : e)));
                  }}
                  onToForm={(summary, shown) => toForm(entry.result, shown, summary)}
                  onCancelRide={(ref) => openCancel(entry.result, ref)}
                  onDiscard={() => close("cancelled")}
                />
              );
            })}
            {sending ? <p className="w-fit animate-pulse rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground" aria-live="polite">…</p> : null}
          </div>
          <form className="flex items-end gap-2 border-t px-4 pt-3" onSubmit={(event) => { event.preventDefault(); void send(text); }}>
            <Textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={placeholder} maxLength={1000} rows={2}
              className="min-h-0 flex-1 resize-none" data-testid="ask-input"
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(text); } }} />
            <Button type="submit" size="icon" disabled={sending || !text.trim()} aria-label={he.ask.send} data-testid="ask-send">
              <SendHorizontal className="size-4 rtl:rotate-180" />
            </Button>
          </form>
          <p className="px-4 pb-3 pt-1 text-xs text-muted-foreground">{he.ask.footer}</p>
        </PortalSheetContent>
      </Sheet>
      <ConfirmDialog
        open={needsDisclaimer}
        onOpenChange={(next) => { if (!next) onOpenChange(false); }}
        title={he.ask.disclaimerTitle}
        confirmLabel={he.ask.disclaimerOk}
        loading={ack.isPending}
        onConfirm={() => ack.mutate()}
      >
        <ul className="space-y-2 text-sm" data-testid="ask-disclaimer">
          {he.ask.disclaimerLines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </ConfirmDialog>
    </>
  );
}

function AnswerView({ entry, active, travel, departmentId, thumbsDown, onThumbsDown, onSend, onLocalChange, onToForm, onOpenRide, onCancelRide, onDiscard }: {
  entry: Extract<Entry, { kind: "answer" }>;
  active: boolean;
  travel: TravelLookup;
  departmentId: string;
  onOpenRide: (rideId: string, weekStart: string, day: string) => void;
  thumbsDown: boolean;
  onThumbsDown: () => void;
  onSend: (message: string, override?: AskDraft) => void;
  onLocalChange: (draft: AskDraft) => void;
  /** `shown`: the draft as the card shows it (with the estimated return), handed to the form. */
  onToForm: (summary: string, shown: AskDraft) => void;
  onCancelRide: (ref: string) => void;
  onDiscard: () => void;
}) {
  const { draft, rides } = entry.result;
  const shown = withAssumedReturn(draft, travel);
  const shownPrevious = entry.previous ? withAssumedReturn(entry.previous, travel) : null;
  const card = buildDraftCard(shown.draft, shownPrevious?.draft ?? null, rides, { draft: shown.assumed, previous: shownPrevious?.assumed });
  const choices = rideChoices(draft, rides);
  const question: CardQuestion | null = card?.question ?? (choices.length ? "which_ride" : null);
  const thumbs = entry.result.turn_id ? (
    <button type="button" onClick={onThumbsDown} disabled={thumbsDown || !active}
      className={cn("text-xs text-muted-foreground underline-offset-2 hover:underline", thumbsDown && "font-semibold no-underline")}
      data-testid="ask-thumbs-down">{he.ask.thumbsDown}</button>
  ) : null;

  if (draft.intent === "find_ride" && draft.date) {
    return (
      <AskFindView draft={draft} departmentId={departmentId} travel={travel} active={active} footer={thumbs} onOpenRide={onOpenRide}
        onRequest={(next) => {
          const filled = withAssumedReturn(next, travel);
          onToForm(buildDraftCard(filled.draft, null, rides, { draft: filled.assumed })?.summary ?? "", filled.draft);
        }} />
    );
  }

  if (!card && !choices.length) {
    return (
      <div className="space-y-2 rounded-lg border p-3 text-sm" data-testid="ask-not-understood">
        <p>{he.ask.notUnderstood}</p>
        <div className="flex flex-wrap gap-2">
          {he.ask.examples.map((example) => (
            <Button key={example} type="button" size="sm" variant="outline" disabled={!active} className="h-auto whitespace-normal py-1.5 text-start"
              onClick={() => onSend(example)}>{example}</Button>
          ))}
        </div>
        {thumbs}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="ask-answer">
      {card ? <AskDraftCardView card={card} updated={card.rows.some((r) => r.changed)} /> : null}
      {question ? <p className="text-sm font-medium" data-testid="ask-question">{he.ask.question[question]}</p> : null}
      {active && question === "which_ride" ? (
        <div className="flex flex-wrap gap-2">
          {choices.map((ride) => (
            <Button key={ride.ref} type="button" size="sm" variant="outline" data-testid="ask-ride-chip"
              onClick={() => {
                if (draft.intent === "cancel_request") onCancelRide(ride.ref);
                else onSend(rideLabel(ride), { ...draft, target_ride: ride.ref, ride_choices: [], ask: null });
              }}>
              <span dir="auto">{rideLabel(ride)}</span>
            </Button>
          ))}
        </div>
      ) : null}
      {active && shown.assumed && !question ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => onLocalChange({ ...draft, trip_type: "one_way", return_time: null })}>{he.ask.oneWayOnly}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onLocalChange({ ...draft, trip_type: "drop_off", return_time: null })}>{he.ask.dropOffOnly}</Button>
        </div>
      ) : null}
      {active && card ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant={card.complete ? "default" : "outline"} onClick={() => onToForm(card.summary, shown.draft)} data-testid="ask-to-form">
            {card.kind === "edit" ? he.ask.toEditForm : he.ask.toForm}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onDiscard} data-testid="ask-discard">{he.ask.cancel}</Button>
          <span className="ms-auto">{thumbs}</span>
        </div>
      ) : thumbs}
    </div>
  );
}
