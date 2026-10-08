/**
 * A bottom `Sheet` on phones, a centred card over the dimmed page from `md` up (owner 2026-10-07:
 * on a computer the request form's pickers and the quick/car-now sheets must not span the whole
 * screen). Fixed-position centring by `inset-0` + `m-auto` + `h-fit` needs no physical left/right,
 * so it is direction-neutral. Append to the `className` of a `side="bottom"` sheet's content.
 */
// The `bottom` sheet variant already centres itself at `md` with `start-1/2` + translate; those are
// reset here (tailwind-merge in `SheetContent` lets the later class win).
export const CENTERED_ON_DESKTOP =
  "md:inset-0 md:start-0 md:end-0 md:translate-x-0 rtl:md:translate-x-0 md:m-auto md:h-fit md:w-full md:max-w-lg md:rounded-xl md:border";

/**
 * The content area of a sheet that hosts a `TimeField15` must be tall enough for the field's hour/minute
 * popover. The popover is portaled *into* the sheet (touch scroll under the modal lock), so it is clipped
 * by the sheet's own `overflow-y-auto` and covered by its sticky footer; the desktop `h-fit` card with a
 * one-row sheet is ~300px while the popover needs ~330px below the input (six and a half 44px rows, R10U6) (owner 2026-10-08: the plan-B
 * time picker was cut off). Reserving the room in the content (above the footer) keeps the footer at the bottom.
 */
export const TIME_FIELD_MIN_HEIGHT = "min-h-[27rem]";
