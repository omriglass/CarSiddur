import { Fragment } from "react";

import type { RichLine } from "@/lib/ridePublicDetails";

/**
 * Lines of text with the names picked out - "<name>:" before a request's words and each name on the "נוסעים נוספים" line
 * are underlined (owner 2026-11-16). Renders inline content; the caller's element keeps `whitespace-pre-wrap`.
 */
export function RichLines({ lines }: { lines: readonly RichLine[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i ? "\n" : null}
          {line.map((segment, j) => (segment.emphasis
            ? <span key={j} className="underline underline-offset-2">{segment.text}</span>
            : <Fragment key={j}>{segment.text}</Fragment>))}
        </Fragment>
      ))}
    </>
  );
}
