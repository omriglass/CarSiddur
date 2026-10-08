// REQ §13.112 (d): "+ ילד/ה" — children without a name, one stepper per seat type (child seat / booster). They are
// the request's own `legacyChildSeats` / `boosters` on top of any named children; shared by the sentence layout's who
// sheet and the classic passengers block.
import { he } from "@/i18n/he";

import { AdultsStepper } from "./AdultsStepper";

export const MAX_UNNAMED_CHILDREN_PER_TYPE = 4;

interface UnnamedChildrenSteppersProps {
  childSeats: number;
  boosters: number;
  onChildSeatsChange: (next: number) => void;
  onBoostersChange: (next: number) => void;
  testId?: string;
}

export function UnnamedChildrenSteppers({ childSeats, boosters, onChildSeatsChange, onBoostersChange, testId = "who-unnamed-children" }: UnnamedChildrenSteppersProps) {
  return (
    <div className="space-y-2" data-testid={testId}>
      <p className="text-sm">{he.requestSentence.whoUnnamedChildren}</p>
      <div className="flex items-center justify-between gap-3 ps-3" data-testid={`${testId}-child-seats`}>
        <span className="text-sm text-muted-foreground">{he.requestSentence.whoChildSeats}</span>
        <AdultsStepper
          value={childSeats}
          max={MAX_UNNAMED_CHILDREN_PER_TYPE}
          onChange={onChildSeatsChange}
          moreLabel={he.requestSentence.whoChildSeatsMore}
          lessLabel={he.requestSentence.whoChildSeatsLess}
          testId={`${testId}-child-seats-stepper`}
        />
      </div>
      <div className="flex items-center justify-between gap-3 ps-3" data-testid={`${testId}-boosters`}>
        <span className="text-sm text-muted-foreground">{he.requestSentence.whoBoosters}</span>
        <AdultsStepper
          value={boosters}
          max={MAX_UNNAMED_CHILDREN_PER_TYPE}
          onChange={onBoostersChange}
          moreLabel={he.requestSentence.whoBoostersMore}
          lessLabel={he.requestSentence.whoBoostersLess}
          testId={`${testId}-boosters-stepper`}
        />
      </div>
    </div>
  );
}
