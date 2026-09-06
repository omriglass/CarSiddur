import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";
import { PlaceholderScreen } from "@/pages/PlaceholderScreen";

export function NotFoundPage() {
  return (
    <PlaceholderScreen title={he.common.notFound}>
      <Button asChild>
        <Link to="/">{he.common.backHome}</Link>
      </Button>
    </PlaceholderScreen>
  );
}
