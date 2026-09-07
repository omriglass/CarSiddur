import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface ListRowsSkeletonProps {
  /** Number of ghost rows (default 4). */
  count?: number;
}

/** Ghost rows matching the admin nav/list card shape (icon chip + title/subtitle) — visual pass deliverable 6. */
export function ListRowsSkeleton({ count = 4 }: ListRowsSkeletonProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="bg-gradient-card shadow-card">
          <CardContent className="flex items-center gap-3 p-4">
            <Skeleton className="size-9 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
