import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface CardListSkeletonProps {
  /** Number of ghost cards (default 3). */
  count?: number;
}

/**
 * Ghost rows matching `RideCard`/request-row card shape (icon chip + two
 * text lines) — Home's upcoming rides/unserved requests, My requests, the
 * siddur day list (visual pass deliverable 6). Loading only, no data.
 */
export function CardListSkeleton({ count = 3 }: CardListSkeletonProps) {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="bg-gradient-card shadow-card">
          <CardContent className="flex gap-3 p-4">
            <Skeleton className="size-9 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
