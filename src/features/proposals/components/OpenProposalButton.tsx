import type { ReactNode } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { useOpenProposal } from "../useOpenProposal";
import { he } from "@/i18n/he";

interface OpenProposalButtonProps {
  proposalId: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  className?: string;
  /** Renders via Radix `Slot` onto `children` instead of a `<button>` (HomePage's next-action card keeps its own markup/look). */
  asChild?: boolean;
  children?: ReactNode;
}

/**
 * Opens a member's own pending proposal at `/p/:token` (Home's next-action
 * card, `RequestRow`'s `proposed`-status rows on `/my` — UX_FLOWS.md §3.3). The
 * plaintext token lives only on the member's own `proposal_received`
 * notification row (`data.url`, computed once by SQL's
 * `notification_default_url()`, DATA_MODEL §3.11), so it's resolved on click
 * rather than kept on the request row. Falls back to the inbox — where the
 * same notification still shows the proposal — if that row can no longer be
 * found (e.g. it was deleted).
 */
export function OpenProposalButton({ proposalId, size, variant = "outline", className, asChild, children }: OpenProposalButtonProps) {
  const { open, pending } = useOpenProposal();

  return (
    <Button
      asChild={asChild}
      size={size}
      variant={variant}
      className={className}
      disabled={pending}
      onClick={() => void open(proposalId)}
    >
      {children ?? he.proposal.open}
    </Button>
  );
}
