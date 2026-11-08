import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { he } from "@/i18n/he";
import type { GuardedChild } from "../api";
import { guardedChildLabel } from "../guardedChildLabel";
import { useGuardedChildrenQuery } from "../hooks";

export function ParentOfCardView({ children }: { children: readonly GuardedChild[] }) {
  if (children.length === 0) return null;
  return (
    <Card data-testid="profile-parent-of">
      <CardHeader>
        <CardTitle className="text-base">{he.profileExtra.parentOfTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1 text-sm">
          {children.map((child) => (
            <li key={child.id}>{guardedChildLabel(child)}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** Read-only "הורה של" card; hidden when I guard no children. */
export function ParentOfCard() {
  const query = useGuardedChildrenQuery();
  return <ParentOfCardView children={query.data ?? []} />;
}
