import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";

interface TableRowsSkeletonProps {
  /** Number of ghost `<td>` cells per row (match the real header's column count). */
  columns: number;
  /** Number of ghost rows (default 5). */
  rows?: number;
}

/** Ghost `<TableRow>`s for admin list tables (CarsPage, MembersPage, etc. — visual pass deliverable 6). Render inside a real `<TableBody>`. */
export function TableRowsSkeleton({ columns, rows = 5 }: TableRowsSkeletonProps) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <TableRow key={r} aria-hidden="true">
          {Array.from({ length: columns }, (_, c) => (
            <TableCell key={c}>
              <Skeleton className="h-4 w-full max-w-32" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
