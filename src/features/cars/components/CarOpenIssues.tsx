import { AlertTriangle } from "lucide-react";

import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { cn } from "@/lib/utils";

import type { OpenCarIssue } from "../api";

interface Selectable {
  /** CR2: a tap on an issue the viewer may act on (`canSelect`) opens its actions. */
  onSelect?: (issue: OpenCarIssue) => void;
  canSelect?: (issue: OpenCarIssue) => boolean;
}

function IssueList({ issues, onSelect, canSelect }: { issues: readonly OpenCarIssue[] } & Selectable) {
  return (
    <ul className="space-y-0.5 ps-5 text-sm" style={{ listStyleType: "disc" }}>
      {issues.map((issue) => {
        const body = (
          <>
            <span className="whitespace-pre-wrap break-words">{issue.description}</span>
            {issue.is_unsafe ? <span className="ms-1.5 text-xs font-bold text-destructive">{he.adminIssues.unsafe}</span> : null}
            <span className="ms-1.5 text-xs text-muted-foreground">{formatDayDate(issue.created_at)}</span>
          </>
        );
        return (
          <li key={issue.id} data-testid="car-open-issue">
            {onSelect && (canSelect?.(issue) ?? true) ? (
              <button type="button" className="rounded text-start underline decoration-dotted underline-offset-4 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(issue)}>
                {body}
              </button>
            ) : body}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * CR1 (REQ item 257): a car's open issues. `banner` = the top of the car page ("⚠ תקלות פתוחות (n)"), shown to
 * everyone; `known` = the report dialog's problem step ("כבר דווח ועדיין פתוח:"), so the same thing is not reported
 * twice. Nothing renders without open issues.
 */
export function CarOpenIssues({ issues, variant, onSelect, canSelect }: { issues: readonly OpenCarIssue[]; variant: "banner" | "known" } & Selectable) {
  if (issues.length === 0) return null;
  if (variant === "known") {
    return (
      <div className="space-y-1 rounded-md border border-maintenance/40 bg-maintenance/10 p-2" data-testid="car-known-issues">
        <p className="text-sm font-medium">{he.carCare.problemOpenIssues}</p>
        <IssueList issues={issues} />
      </div>
    );
  }
  return (
    <section
      role="note"
      className={cn("space-y-1 rounded-lg border border-maintenance bg-maintenance/10 p-3")}
      data-testid="car-open-issues"
    >
      <p className="flex items-center gap-1.5 font-semibold text-maintenance">
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        {tv("carPage.openIssues", { count: String(issues.length) })}
      </p>
      <IssueList issues={issues} onSelect={onSelect} canSelect={canSelect} />
    </section>
  );
}
