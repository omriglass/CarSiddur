import { useParams } from "react-router-dom";

import { ChecklistEditorScreen } from "@/features/cars/checklist/components/ChecklistEditorScreen";

/** `/cars/checklist/:dept` — the department's handover checklist editor (REQ item 150 d, UX_FLOWS.md §5.15). */
export function CarChecklistEditorPage() {
  const { dept } = useParams<{ dept: string }>();
  if (!dept) return null;
  return <ChecklistEditorScreen departmentId={dept} />;
}
