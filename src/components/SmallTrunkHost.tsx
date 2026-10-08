import { useEffect } from "react";

import { useSmallTrunkConfirm } from "@/components/useSmallTrunkConfirm";
import { registerSmallTrunkAsker } from "@/lib/smallTrunk";

/**
 * REQ §13.111 (a): the one "צריך תא מטען גדול - לשבץ בכל זאת?" dialog of the app. Mounted once in
 * `main.tsx`; every `api.ts` wrapper of a manual-placement RPC reaches it through `withSmallTrunkRetry`.
 */
export function SmallTrunkHost() {
  const { ask, dialog } = useSmallTrunkConfirm();
  useEffect(() => {
    registerSmallTrunkAsker(ask);
    return () => registerSmallTrunkAsker(null);
  }, [ask]);
  return <>{dialog}</>;
}
