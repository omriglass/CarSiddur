// The "who travels" text shared by the sentence form's who chip and the `/my` request card (R11U2/R11U3):
// names first, then the unnamed tail — "אני, יהלי מלכה ועוד 2 מבוגרים ו־2 ילדים". Pure apart from the dictionary.
import { he, tv } from "@/i18n/he";

import { joinWho, unnamedWhoLabel } from "./components/requestForm/sentence/sentenceModel";

/** The tail for people without a name, or `null`. */
export function unnamedTail(extraAdults: number, unnamedChildren: number): string | null {
  return unnamedWhoLabel(extraAdults, unnamedChildren, {
    adultOne: he.requestSentence.whoMoreOne,
    adultMany: (n) => tv("requestSentence.whoMoreMany", { n: String(n) }),
    moreChildOne: he.requestSentence.whoMoreChildOne,
    childOne: he.requestSentence.whoChildOne,
    childMany: (n) => tv("requestSentence.whoChildMany", { n: String(n) }),
    and: he.requestSentence.and,
    andNumber: he.requestSentence.andNumber,
  });
}

/** "A, B ועוד 2 מבוגרים ו־2 ילדים" — `names` are every named person to list (including "אני" where wanted). */
export function whoText(names: readonly string[], extraAdults: number, unnamedChildren: number): string {
  return joinWho(names, he.requestSentence.and, unnamedTail(extraAdults, unnamedChildren), he.requestSentence.andNumber);
}
