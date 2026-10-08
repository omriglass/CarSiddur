import type { DestinationPreset } from "./DestinationCombobox";

/** Matches presets by name, alias or zone (UX_FLOWS.md §3.4 "DestinationCombobox searches presets by name and aliases"). */
export function filterDestinations<T extends DestinationPreset>(
  destinations: readonly T[],
  query: string,
): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...destinations];
  return destinations.filter((dest) => {
    const haystacks = [dest.name, dest.zone ?? "", ...dest.aliases];
    return haystacks.some((h) => h.toLowerCase().includes(normalized));
  });
}
