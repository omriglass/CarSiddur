/** CR1 (REQ item 257): how many open issues each car has. */
export function countByCar(issues: readonly { car_id: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const issue of issues) counts.set(issue.car_id, (counts.get(issue.car_id) ?? 0) + 1);
  return counts;
}
