import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { paths } from "@/app/routes";
import { useProposalLinkMutation } from "@/features/inbox/hooks";
import { he } from "@/i18n/he";

/**
 * Opens a member's own pending proposal (see `OpenProposalButton`); shared with the "my rides" week view, where a
 * proposal block is tapped instead of pressing a button.
 */
export function useOpenProposal(): { open: (proposalId: string) => Promise<void>; pending: boolean } {
  const navigate = useNavigate();
  const linkMutation = useProposalLinkMutation();

  async function open(proposalId: string) {
    let url: string | null = null;
    try {
      url = await linkMutation.mutateAsync(proposalId);
    } catch {
      url = null;
    }
    if (url) {
      navigate(url);
    } else {
      toast(he.proposal.openFallback);
      navigate(paths.inbox());
    }
  }

  return { open, pending: linkMutation.isPending };
}
