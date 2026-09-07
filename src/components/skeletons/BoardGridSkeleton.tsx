import { Skeleton } from "@/components/ui/skeleton";

interface BoardGridSkeletonProps {
  /** Number of ghost car columns (default 4). */
  columns?: number;
}

/**
 * Ghost car columns with three staggered ghost ride blocks each, echoing
 * `WeekGrid`'s sticky car-header + absolutely-positioned block layout
 * without needing real geometry math (visual pass deliverable 6, board
 * loading state).
 */
export function BoardGridSkeleton({ columns = 4 }: BoardGridSkeletonProps) {
  return (
    <div className="overflow-hidden rounded-md border shadow-card" aria-hidden="true">
      <div className="flex divide-x divide-x-reverse divide-border border-b bg-muted/70">
        {Array.from({ length: columns }, (_, i) => (
          <div key={i} className="flex-1 space-y-1 p-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
      <div className="flex divide-x divide-x-reverse divide-border">
        {Array.from({ length: columns }, (_, i) => (
          <div key={i} className="flex-1 space-y-3 p-2">
            <Skeleton className="h-10 w-full" style={{ marginTop: `${(i % 3) * 12}px` }} />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
