import { Input } from "@/components/ui/input";

/**
 * Renders a form for a rule's `params` generically from its current shape
 * (`ruleRegistry[type].defaultParams`, docs/SOLVER.md §4.1/§4.5): a numeric
 * leaf becomes a number input; a nested object (e.g. `rideType.weights`
 * keyed by `ride_types.code`) becomes one number input per key. Rules with
 * no fields (`publicTransport`, `manualBoost`, `{}`) render nothing. No rule
 * type needs a special case here — new rule types stay editable for free.
 */
export function RuleParamsEditor({
  params,
  onChange,
  keyLabels,
  paramLabels,
}: {
  params: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** optional key -> Hebrew label map (e.g. ride type code -> name_he) for nested-object params. */
  keyLabels?: Record<string, string>;
  /** Hebrew labels for the rule's own setting names. */
  paramLabels?: Record<string, string>;
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
          return (
            <div key={key} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{paramLabels?.[key] ?? key}</span>
              <div className="flex flex-wrap gap-2">
                {Object.entries(nested).map(([nestedKey, nestedValue]) => (
                  <label key={nestedKey} className="flex flex-col gap-1 text-xs">
                    {keyLabels?.[nestedKey] ?? nestedKey}
                    <Input
                      type="number"
                      className="w-20"
                      value={nestedValue}
                      onChange={(e) =>
                        onChange({ ...params, [key]: { ...nested, [nestedKey]: Number(e.target.value) } })
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
