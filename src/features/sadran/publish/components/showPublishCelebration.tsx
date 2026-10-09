import { createRoot } from "react-dom/client";

import type { CelebrationStats } from "../celebrationStats";
import { PublishCelebration } from "./PublishCelebration";

/**
 * Mounts the celebration in its own React root so it outlives the publish screen's navigation to
 * the board. Cosmetic only; dismisses on tap, Esc or after 5 s.
 */
export function showPublishCelebration(stats: CelebrationStats): void {
  if (typeof document === "undefined") return;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let done = false;
  const onDone = () => {
    if (done) return;
    done = true;
    // Unmount after the current event so a click handler is not torn down mid-dispatch.
    window.setTimeout(() => { root.unmount(); host.remove(); }, 0);
  };
  root.render(<PublishCelebration stats={stats} onDone={onDone} />);
}
