// Times inside a Hebrew line must read left-to-right ("<span dir=ltr>", CLAUDE.md RTL rules):
// wraps every HH:MM in the text.
import { Fragment } from "react";

const TIME_PATTERN = /(\d{1,2}:\d{2})/g;

export function LtrText({ text }: { text: string }) {
  const parts = text.split(TIME_PATTERN);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} dir="ltr">{part}</span>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}
