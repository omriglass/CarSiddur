import { Link, type LinkProps } from "react-router-dom";

import { useRequestLinkProps } from "@/app/overlayState";

/**
 * `<Link>` to `paths.requests.new/edit`: remembers the current page so the sentence-layout form
 * opens as an overlay on top of it (UX_FLOWS §3.4a).
 */
export function RequestLink(props: Omit<LinkProps, "state">) {
  const linkProps = useRequestLinkProps();
  return <Link {...linkProps} {...props} />;
}
