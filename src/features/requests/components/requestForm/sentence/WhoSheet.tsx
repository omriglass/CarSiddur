// UX_FLOWS §3.4a "Who sheet": the body of the "מי נוסע?" sheet, built like the destination sheet —
// toggle chips first ("אני" always on, the member's OWN children (guardian), recent companions,
// whoever is already picked, each guest — named or not — with ×), then three ways to add (owner 2026-11-09):
// "+ חבר/ה או ילד/ה" (inline search over members AND every child of the department), "+ אורח/ת מבוגר/ת" (a name,
// optional — none is an unnamed adult, R9M1) and, smaller since it is rare, "+ ילד/ה אורח/ת" (a child seat or a
// booster, REQ §13.112 d). The open panel sits right under them, above the sheet's "אישור". Writes the classic
// `companions` / `children` / `extraAdults` / `legacyChildSeats` / `boosters` / `guestNames` fields, so seat counting
// is untouched.
import { X } from "lucide-react";
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { he } from "@/i18n/he";

import { guestPassengerNames } from "../../../quickRequest";
import type { RequestFormValues } from "../../../schema";
import { FieldError } from "../FieldError";
import { InlineSearchList } from "./InlineSearchList";
import { PillChip } from "./PillChip";

interface WhoSheetProps {
  form: UseFormReturn<RequestFormValues>;
  members: { id: string; name: string }[];
  /** REQ §13.127 (a): "אני" is on (default); a new weekly request may switch it off (`allowOnBehalf`). */
  includeMe: boolean;
  /** The requester chip toggles: a new weekly request ("אני"), or an edit (REQ §13.169 b — the requester rides or not). */
  allowOnBehalf: boolean;
  /** Edit of a request whose requester is someone else: shown instead of "אני". */
  requesterName?: string | null;
  /** REQ §13.169 (b), edit: the riders who drive; two or more show "מי נוהג/ת?". */
  driverOptions?: readonly { id: string; name: string }[];
  driverId?: string | null;
  childOptions: { id: string; name: string; age: number | null; isPriority?: boolean }[];
  recentCompanionIds: readonly string[];
  companions: readonly string[];
  children: readonly string[];
  guestNames: string;
  extraAdults: number;
  /** REQ §13.112 (d): unnamed children, a child seat or a booster each (`legacyChildSeats` / `boosters`). */
  unnamedChildSeats: number;
  boosters: number;
  guestNamesError?: string;
  /** REQ §13.127 (a): "אני" is off and no department member is named. */
  companionsError?: string;
  /** A named child was just added (suggests the childcare ride type, R9U7). */
  onChildAdded?: () => void;
}

const CHILD_KEY = "child:";

function toggle(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((value) => value !== id) : [...list, id];
}

export function WhoSheet({ form, members, includeMe, allowOnBehalf, requesterName, driverOptions = [], driverId = null, childOptions, recentCompanionIds, companions, children, guestNames, extraAdults, unnamedChildSeats, boosters, guestNamesError, companionsError, onChildAdded }: WhoSheetProps) {
  const [mode, setMode] = useState<"member" | "guest" | "childGuest" | null>(null);
  const [guestDraft, setGuestDraft] = useState("");
  const guests = guestPassengerNames(guestNames);
  const memberById = new Map(members.map((member) => [member.id, member]));
  // Selected first (stable order of picking), then the recent ones that are not selected.
  const companionIds = [...companions, ...recentCompanionIds.filter((id) => !companions.includes(id))].filter((id) => memberById.has(id));

  const childById = new Map(childOptions.map((child) => [child.id, child]));
  // R9U3: own children as quick chips (plus any other child already picked); the rest via search.
  const childChips = childOptions.filter((child) => child.isPriority || children.includes(child.id));

  function toggleChild(id: string) {
    if (!children.includes(id)) onChildAdded?.();
    form.setValue("children", toggle(children, id), { shouldDirty: true, shouldValidate: true });
  }

  function setCompanions(next: string[]) {
    form.setValue("companions", next, { shouldDirty: true, shouldValidate: true });
  }

  /** A typed name is a named guest; an empty one an unnamed adult. */
  function addGuest() {
    const name = guestDraft.trim();
    if (name) form.setValue("guestNames", [...guests, name].join("\n"), { shouldDirty: true, shouldValidate: true });
    else form.setValue("extraAdults", extraAdults + 1, { shouldDirty: true, shouldValidate: true });
    setGuestDraft("");
    setMode(null);
  }

  function addChildGuest(seat: "legacyChildSeats" | "boosters") {
    form.setValue(seat, (seat === "boosters" ? boosters : unnamedChildSeats) + 1, { shouldDirty: true, shouldValidate: true });
    setMode(null);
  }

  function removeGuest(index: number) {
    form.setValue("guestNames", guests.filter((_, i) => i !== index).join("\n"), { shouldDirty: true, shouldValidate: true });
  }

  return (
    <div className="space-y-3" data-testid="who-sheet" data-field="companions">
      <div className="flex flex-wrap gap-1.5">
        {allowOnBehalf ? (
          <PillChip
            pressed={includeMe}
            aria-label={he.requestSentence.whoMeToggle}
            onClick={() => form.setValue("includeMe", !includeMe, { shouldDirty: true, shouldValidate: true })}
            data-testid="who-me"
          >
            {requesterName ?? he.requestSentence.me}
          </PillChip>
        ) : (
          <PillChip pressed disabled aria-disabled="true" data-testid="who-me">{requesterName ?? he.requestSentence.me}</PillChip>
        )}
        {childChips.map((child) => (
          <PillChip
            key={child.id}
            pressed={children.includes(child.id)}
            onClick={() => toggleChild(child.id)}
            data-testid={`who-child-${child.id}`}
          >
            {child.name}
          </PillChip>
        ))}
        {companionIds.map((id) => (
          <PillChip key={id} pressed={companions.includes(id)} onClick={() => setCompanions(toggle(companions, id))} data-testid={`who-member-${id}`}>
            {memberById.get(id)?.name}
          </PillChip>
        ))}
        {guests.map((name, index) => (
          <PillChip key={`${index}:${name}`} pressed aria-label={`${name} ×`} onClick={() => removeGuest(index)}>
            {name}
            <X className="size-3" aria-hidden="true" />
          </PillChip>
        ))}
        {Array.from({ length: extraAdults }, (_, index) => (
          <PillChip key={`adult:${index}`} pressed aria-label={`${he.requestSentence.whoUnnamedAdultChip} ×`} data-testid="who-unnamed-adult"
            onClick={() => form.setValue("extraAdults", extraAdults - 1, { shouldDirty: true, shouldValidate: true })}>
            {he.requestSentence.whoUnnamedAdultChip}
            <X className="size-3" aria-hidden="true" />
          </PillChip>
        ))}
        {Array.from({ length: unnamedChildSeats }, (_, index) => (
          <PillChip key={`seat:${index}`} pressed aria-label={`${he.requestSentence.whoChildSeatChip} ×`} data-testid="who-child-seat"
            onClick={() => form.setValue("legacyChildSeats", unnamedChildSeats - 1, { shouldDirty: true, shouldValidate: true })}>
            {he.requestSentence.whoChildSeatChip}
            <X className="size-3" aria-hidden="true" />
          </PillChip>
        ))}
        {Array.from({ length: boosters }, (_, index) => (
          <PillChip key={`booster:${index}`} pressed aria-label={`${he.requestSentence.whoBoosterChip} ×`} data-testid="who-booster"
            onClick={() => form.setValue("boosters", boosters - 1, { shouldDirty: true, shouldValidate: true })}>
            {he.requestSentence.whoBoosterChip}
            <X className="size-3" aria-hidden="true" />
          </PillChip>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <PillChip dashed onClick={() => setMode(mode === "member" ? null : "member")} data-testid="who-add-member">{he.requestSentence.whoAddMember}</PillChip>
        <PillChip dashed onClick={() => setMode(mode === "guest" ? null : "guest")} data-testid="who-add-guest">{he.requestSentence.whoAddGuest}</PillChip>
        <button type="button" className="px-1 text-xs text-muted-foreground underline underline-offset-2" onClick={() => setMode(mode === "childGuest" ? null : "childGuest")} data-testid="who-add-child-guest">
          {he.requestSentence.whoAddChildGuest}
        </button>
      </div>

      {mode === "member" ? (
        <InlineSearchList
          autoFocus
          placeholder={he.requestSentence.whoMemberSearch}
          emptyText={he.requestSentence.whoNoMembers}
          getItems={(query) => {
            const needle = query.toLowerCase();
            const memberItems = members
              .filter((member) => !needle || member.name.toLowerCase().includes(needle))
              .map((member) => ({ key: member.id, label: member.name, selected: companions.includes(member.id) }));
            // Children of other families are only reachable by typing a name (R9U3).
            const childItems = needle
              ? childOptions
                  .filter((child) => child.name.toLowerCase().includes(needle))
                  .map((child) => ({ key: `${CHILD_KEY}${child.id}`, label: child.age == null ? child.name : `${child.name} · ${child.age}`, selected: children.includes(child.id) }))
              : [];
            return [...memberItems, ...childItems];
          }}
          onSelect={(key) => {
            if (key.startsWith(CHILD_KEY) && childById.has(key.slice(CHILD_KEY.length))) toggleChild(key.slice(CHILD_KEY.length));
            else setCompanions(toggle(companions, key));
            setMode(null);
          }}
        />
      ) : null}

      {mode === "guest" ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); addGuest(); }}
        >
          <Input
            autoFocus
            value={guestDraft}
            onChange={(event) => setGuestDraft(event.target.value)}
            // Owner 2026-11-09: a typed name is never lost — leaving the field (e.g. for "אישור") adds it.
            onBlur={(event) => { if (guestDraft.trim() && !event.currentTarget.form?.contains(event.relatedTarget as Node | null)) addGuest(); }}
            placeholder={he.requestSentence.whoGuestPlaceholder}
            aria-label={he.requestSentence.whoGuestPlaceholder}
            maxLength={100}
            className="h-10"
          />
          <Button type="submit" variant="secondary" className="h-10 shrink-0">{he.requestSentence.whoGuestAdd}</Button>
        </form>
      ) : null}

      {mode === "childGuest" ? (
        <div className="space-y-1.5" data-testid="who-child-guest">
          <p className="text-sm">{he.requestSentence.whoChildGuestQuestion}</p>
          <div className="flex flex-wrap gap-1.5">
            <PillChip onClick={() => addChildGuest("legacyChildSeats")} data-testid="who-child-guest-seat">{he.requestSentence.whoChildSeats}</PillChip>
            <PillChip onClick={() => addChildGuest("boosters")} data-testid="who-child-guest-booster">{he.requestSentence.whoBoosters}</PillChip>
          </div>
        </div>
      ) : null}

      {driverOptions.length > 1 ? (
        <div className="space-y-1.5" data-testid="who-driver">
          <p className="text-sm">{he.requestSentence.whoDriver}</p>
          <div className="flex flex-wrap gap-1.5">
            {driverOptions.map((option) => (
              <PillChip
                key={option.id}
                pressed={option.id === driverId}
                onClick={() => form.setValue("driverId", option.id, { shouldDirty: true, shouldValidate: true })}
                data-testid={`who-driver-${option.id}`}
              >
                {option.name}
              </PillChip>
            ))}
          </div>
        </div>
      ) : null}

      <FieldError message={guestNamesError} />
      <FieldError message={companionsError} />
    </div>
  );
}
