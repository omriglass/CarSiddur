// UX_FLOWS §3.4a "Who sheet": the body of the "מי נוסע?" sheet, built like the destination sheet —
// toggle chips first ("אני" always on, the member's OWN children (guardian), recent companions,
// whoever is already picked), then "+ חבר/ה" (inline search over members AND every child of the
// department), "+ אורח/ת" (a guest name), the unnamed-adults stepper (R9M1) and the unnamed-children steppers
// ("+ ילד/ה", REQ §13.112 d). Writes the classic `companions` / `children` / `extraAdults` / `legacyChildSeats` /
// `boosters` / `guestNames` fields, so seat counting is untouched.
import { X } from "lucide-react";
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { he } from "@/i18n/he";

import { guestPassengerNames } from "../../../quickRequest";
import type { RequestFormValues } from "../../../schema";
import { FieldError } from "../FieldError";
import { AdultsStepper } from "../AdultsStepper";
import { UnnamedChildrenSteppers } from "../UnnamedChildrenSteppers";
import { InlineSearchList } from "./InlineSearchList";
import { PillChip } from "./PillChip";

interface WhoSheetProps {
  form: UseFormReturn<RequestFormValues>;
  members: { id: string; name: string }[];
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
  /** A named child was just added (suggests the childcare ride type, R9U7). */
  onChildAdded?: () => void;
}

const CHILD_KEY = "child:";

function toggle(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((value) => value !== id) : [...list, id];
}

export function WhoSheet({ form, members, childOptions, recentCompanionIds, companions, children, guestNames, extraAdults, unnamedChildSeats, boosters, guestNamesError, onChildAdded }: WhoSheetProps) {
  const [mode, setMode] = useState<"member" | "guest" | null>(null);
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

  function addGuest() {
    const name = guestDraft.trim();
    if (!name) return;
    form.setValue("guestNames", [...guests, name].join("\n"), { shouldDirty: true, shouldValidate: true });
    setGuestDraft("");
    setMode(null);
  }

  function removeGuest(index: number) {
    form.setValue("guestNames", guests.filter((_, i) => i !== index).join("\n"), { shouldDirty: true, shouldValidate: true });
  }

  return (
    <div className="space-y-3" data-testid="who-sheet" data-field="companions">
      <div className="flex flex-wrap gap-1.5">
        <PillChip pressed disabled aria-disabled="true" data-testid="who-me">{he.requestSentence.me}</PillChip>
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
        <PillChip dashed onClick={() => setMode(mode === "member" ? null : "member")} data-testid="who-add-member">{he.requestSentence.whoAddMember}</PillChip>
        <PillChip dashed onClick={() => setMode(mode === "guest" ? null : "guest")} data-testid="who-add-guest">{he.requestSentence.whoAddGuest}</PillChip>
      </div>

      <div className="flex items-center justify-between gap-3" data-testid="who-extra-adults">
        <span className="text-sm">{he.requestSentence.whoExtraAdults}</span>
        <AdultsStepper
          value={extraAdults}
          onChange={(next) => form.setValue("extraAdults", next, { shouldDirty: true, shouldValidate: true })}
          moreLabel={he.requestSentence.whoExtraAdultsMore}
          lessLabel={he.requestSentence.whoExtraAdultsLess}
          testId="who-extra-adults-stepper"
        />
      </div>

      <UnnamedChildrenSteppers
        childSeats={unnamedChildSeats}
        boosters={boosters}
        onChildSeatsChange={(next) => form.setValue("legacyChildSeats", next, { shouldDirty: true, shouldValidate: true })}
        onBoostersChange={(next) => form.setValue("boosters", next, { shouldDirty: true, shouldValidate: true })}
      />

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
            placeholder={he.requestSentence.whoGuestPlaceholder}
            aria-label={he.requestSentence.whoGuestPlaceholder}
            maxLength={100}
            className="h-10"
          />
          <Button type="submit" variant="secondary" className="h-10 shrink-0">{he.requestSentence.whoGuestAdd}</Button>
        </form>
      ) : null}
      <FieldError message={guestNamesError} />
    </div>
  );
}
