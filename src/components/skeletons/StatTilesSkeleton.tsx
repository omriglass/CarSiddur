import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface StatTilesSkeletonProps {
  /** Number of ghost tiles (default 6, matching the Sadran dashboard's counter row). */
  count?: number;
}

/** Ghost stat tiles matching the Sadran dashboard's counter row shape (visual pass deliverable 6). */
export function StatTilesSkeleton({ count = 6 }: StatTilesSkeletonProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="border-t-4 border-t-border bg-gradient-card shadow-card">
          <CardContent className="flex flex-col items-center gap-2 p-3">
            <Skeleton className="h-7 w-10" />
            <Skeleton className="h-3 w-14" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
