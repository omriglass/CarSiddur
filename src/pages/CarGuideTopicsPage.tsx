import { useParams } from "react-router-dom";

import { GuideTopicsScreen } from "@/features/cars/guides/components/GuideTopicsScreen";

/** `/cars/guides/:dept` — the department's guide topics, "איך עושים…" (REQ item 259, UX_FLOWS.md §5.16). */
export function CarGuideTopicsPage() {
  const { dept } = useParams<{ dept: string }>();
  if (!dept) return null;
  return <GuideTopicsScreen departmentId={dept} />;
}
