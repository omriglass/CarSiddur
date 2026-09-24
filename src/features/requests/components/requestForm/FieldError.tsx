// Extracted from `RequestForm.tsx` (docs/TODO.md "Code review 2026-09-24" R9):
// the small inline validation-message helper every field group below uses.
// Pure move — behaviour unchanged.
export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p role="alert" className="text-sm font-medium text-destructive">{message}</p>;
}
