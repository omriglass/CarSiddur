import type { ReactNode } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface PlaceholderScreenProps {
  title: string;
  description?: string;
  children?: ReactNode;
}

/**
 * Route-level placeholder used until each screen's real feature (`src/features/*`)
 * lands (ARCHITECTURE.md §4: pages compose features, no business logic).
 */
export function PlaceholderScreen({ title, description, children }: PlaceholderScreenProps) {
  return (
    <div className="mx-auto max-w-2xl p-4">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        {children ? <CardContent>{children}</CardContent> : null}
      </Card>
    </div>
  );
}
