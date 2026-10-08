// The flexibility text of the sentence chip ("±½ ש׳", "½ ש׳ מוקדם / ¼ ש׳ מאוחר") — shared by the form's time chip
// and the Excel export's request sentence. Pure apart from the dictionary.
import type { FlexValue } from "@/components/flexibilityValues";
import { he, tv } from "@/i18n/he";

import type { FlexBrief } from "./components/requestForm/sentence/sentenceModel";

export function flexAmountLabel(value: FlexValue): string {
  return he.requestSentence.flexChip[String(value) as keyof typeof he.requestSentence.flexChip];
}

/** The brief's text, or "" for no flexibility. */
export function flexBriefText(brief: FlexBrief): string {
  if (brief.kind === "both") return tv("requestSentence.flexBrief", { amount: flexAmountLabel(brief.value) });
  if (brief.kind === "split") {
    return [
      brief.early !== 0 ? tv("requestSentence.flexBriefEarly", { amount: flexAmountLabel(brief.early) }) : null,
      brief.late !== 0 ? tv("requestSentence.flexBriefLate", { amount: flexAmountLabel(brief.late) }) : null,
    ].filter(Boolean).join(" / ");
  }
  return "";
}
