import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Renders a form for a rule's `params` generically from its current shape
 * (`ruleRegistry[type].defaultParams`, docs/SOLVER.md §4.1/§4.5): a numeric
 * leaf becomes a number input; a nested object (e.g. `rideType.weights`
 * keyed by `ride_types.code`) becomes one number input per key. Rules with
 * no fields (`publicTransport`, `manualBoost`, `{}`) render nothing. No rule
 * type needs a special case here — new rule types stay editable for free.
 *
 * `staleNestedKeys` lets a caller flag nested-object keys that no longer
 * correspond to live admin data (e.g. a `rideType.weights` code whose
 * `ride_types` row was deleted after this policy was last saved): rendered
 * disabled/greyed with `staleHint` and a small remove control. Which keys are
 * "expected" is admin data the caller knows (e.g. the current ride types
 * query) and this component does not — it only renders what `staleNestedKeys`
 * tells it to grey out.
 */
export function RuleParamsEditor({
  params,
  onChange,
  keyLabels,
  paramLabels,
  staleNestedKeys,
  staleHint,
  removeLabel,
}: {
  params: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** optional key -> Hebrew label map (e.g. ride type code -> name_he) for nested-object params. */
  keyLabels?: Record<string, string>;
  /** Hebrew labels for the rule's own setting names. */
  paramLabels?: Record<string, string>;
  /** nested-object param name -> keys present in `params[name]` that are no longer live admin data. */
  staleNestedKeys?: Record<string, string[]>;
  /** Hebrew hint shown next to a stale key (e.g. "לא בשימוש"). */
  staleHint?: string;
  /** aria-label for the remove-stale-key button. */
  removeLabel?: string;
}) {
  const entries = Object.entries(params);
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-4">
      {entries.map(([key, value]) => {
        if (typeof value === "number") {
          return (
            <label key={key} className="flex flex-col gap-1 text-xs">
              {paramLabels?.[key] ?? key}
              <Input
                type="number"
                className="w-24"
                value={value}
                onChange={(e) => onChange({ ...params, [key]: Number(e.target.value) })}
              />
            </label>
          );
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const nested = value as Record<string, number>;
          const stale = new Set(staleNestedKeys?.[key] ?? []);
          return (
            <div key={key} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{paramLabels?.[key] ?? key}</span>
              <div className="flex flex-wrap gap-2">
                {Object.entries(nested).map(([nestedKey, nestedValue]) => {
                  const isStale = stale.has(nestedKey);
                  return (
                    <label
                      key={nestedKey}
                      className={cn("flex flex-col gap-1 text-xs", isStale && "opacity-50")}
                    >
                      <span className="flex items-center gap-1">
                        {keyLabels?.[nestedKey] ?? nestedKey}
                        {isStale && <span className="text-muted-foreground">({staleHint})</span>}
                      </span>
                      <span className="flex items-center gap-1">
                        <Input
                          type="number"
                          className="w-20"
                          value={nestedValue}
                          disabled={isStale}
                          onChange={(e) =>
                            onChange({ ...params, [key]: { ...nested, [nestedKey]: Number(e.target.value) } })
                          }
                        />
                        {isStale && (
                          <button
                            type="button"
                            aria-label={removeLabel ?? nestedKey}
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => {
                              const rest = { ...nested };
                              delete rest[nestedKey];
                              onChange({ ...params, [key]: rest });
                            }}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
