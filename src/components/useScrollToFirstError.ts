import { useCallback, type RefObject } from "react";
import type { FieldErrors, FieldValues, SubmitErrorHandler, UseFormReturn } from "react-hook-form";

/**
 * Elements react-hook-form's default `shouldFocusError` can already focus (any node with a
 * real DOM `ref`, or one Radix/shadcn attaches `aria-invalid`/`id` to via `FormControl`'s
 * `Slot`). Used both to pick a focus target from a matched container and, as a last resort,
 * to scan the whole form for whichever invalid control rendered.
 */
const FOCUSABLE_SELECTOR = 'input, select, textarea, button, [tabindex], [contenteditable="true"], a[href]';

function isFocusable(el: HTMLElement): boolean {
  return el.matches(FOCUSABLE_SELECTOR);
}

/** First path segment of a react-hook-form field name (`"children.0.name"` → `"children"`). */
function topLevelSegment(name: string): string {
  const match = /^[^.[]+/.exec(name);
  return match ? match[0] : name;
}

/**
 * Locates the element standing in for RHF field `name` inside `container`: an exact
 * `data-field`/`name` match first (custom controls carry `data-field`, registered inputs
 * carry `name`), then the same lookup against the name's top-level segment (nested/array
 * fields — `CompanionPicker`'s `data-field="children"` wrapper for a `"children.0"` error).
 */
export function findFieldElement(container: HTMLElement, name: string): HTMLElement | null {
  const byExactName = (candidate: string) =>
    container.querySelector<HTMLElement>(`[data-field="${candidate}"]`) ??
    container.querySelector<HTMLElement>(`[name="${candidate}"]`);

  const exact = byExactName(name);
  if (exact) return exact;

  const prefix = topLevelSegment(name);
  if (prefix !== name) {
    const byPrefix = byExactName(prefix);
    if (byPrefix) return byPrefix;
  }
  return null;
}

/**
 * Picks the first invalid element in DOM order — for each error key (already in the form's
 * validation order, which is also insertion order) it resolves an element via
 * `findFieldElement`; if no key resolves to anything (fields not wired with `data-field`,
 * e.g. plain shadcn `FormControl`s that already forward `aria-invalid` to their own DOM node)
 * it falls back to the topmost `[aria-invalid="true"]` anywhere in the container.
 */
export function findFirstInvalidElement<TFieldValues extends FieldValues>(
  container: HTMLElement,
  errors: FieldErrors<TFieldValues>,
): HTMLElement | null {
  const candidates: HTMLElement[] = [];
  for (const key of Object.keys(errors)) {
    const el = findFieldElement(container, key);
    if (el) candidates.push(el);
  }
  if (candidates.length === 0) {
    candidates.push(...Array.from(container.querySelectorAll<HTMLElement>('[aria-invalid="true"]')));
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((topmost, el) =>
    el.getBoundingClientRect().top < topmost.getBoundingClientRect().top ? el : topmost,
  );
}

/**
 * Scrolls `el` into view (centered, so a fixed sticky submit bar never covers it — works
 * inside a `Sheet`/`Dialog`'s own scroll container too, not just the page) and focuses it: the
 * element itself if it's natively focusable, else its first focusable descendant (e.g. a
 * `data-field` wrapper around `DateField`'s radio buttons), else the element itself made
 * focusable with `tabIndex=-1`.
 */
export function focusInvalidElement(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  if (isFocusable(el)) {
    el.focus({ preventScroll: true });
    return;
  }
  const descendant = el.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
  if (descendant) {
    descendant.focus({ preventScroll: true });
    return;
  }
  el.tabIndex = -1;
  el.focus({ preventScroll: true });
}

/** Finds the first invalid field in `container` and scrolls/focuses it in one call. */
export function scrollToFirstInvalid<TFieldValues extends FieldValues>(
  container: HTMLElement,
  errors: FieldErrors<TFieldValues>,
): void {
  const el = findFirstInvalidElement(container, errors);
  if (el) focusInvalidElement(el);
}

/**
 * `onInvalid` handler for `form.handleSubmit(onValid, onInvalid)`: on a failed submit, scrolls
 * to and focuses the first invalid field in `formRef.current` (mobile-first — react-hook-form's
 * own `shouldFocusError` only reaches fields with a registered DOM ref, so this also covers the
 * custom controlled inputs — `DateField`, `TimeField15`, `PassengerStepper`,
 * `FlexibilitySegmented`/`FlexibilityRange`, `DestinationCombobox` — that carry a `data-field`
 * prop instead). Every wired form passes this as its `onInvalid` and gives its `<form>` the
 * matching `ref`.
 */
export function useScrollToFirstError<TFieldValues extends FieldValues>(
  // Not read — `errors` arrives as the returned callback's own argument. Taking `form` keeps
  // every call site pairing the hook with the exact form instance it scrolls, and lets
  // `TFieldValues` infer from `form` instead of needing an explicit type argument.
  _form: UseFormReturn<TFieldValues>,
  formRef: RefObject<HTMLElement>,
): SubmitErrorHandler<TFieldValues> {
  return useCallback(
    (errors) => {
      const container = formRef.current;
      if (!container) return;
      scrollToFirstInvalid(container, errors);
    },
    [formRef],
  );
}
