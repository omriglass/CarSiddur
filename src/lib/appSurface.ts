/**
 * REQ §13.138 (c): which screen the user is acting from. While the Sadran board is open, every database API call
 * carries the header `x-app-surface: board`, and the server holds the notices of those changes until
 * "שלח את כל ההצעות" (`enqueue_notification` -> `_board_hold_applies`). Anywhere else (the siddur, a member's
 * screens) changes notify at once. Set by `useBoardSurface()` while the board is mounted.
 */
export type AppSurface = "board";

export const APP_SURFACE_HEADER = "x-app-surface";

let current: AppSurface | null = null;

export function setAppSurface(surface: AppSurface | null): void {
  current = surface;
}

export function appSurface(): AppSurface | null {
  return current;
}

/**
 * REQ §13.169 (c): the calls of a save from the request form carry `x-request-form: 1`, so the server tells the
 * request's riders what the save changed in one `ride_edited` notice (and skips that save's older edit notices).
 */
export const REQUEST_FORM_HEADER = "x-request-form";

let requestFormSaves = 0;

/** Runs one request-form save; every database call made until it settles carries the request-form header. */
export async function asRequestFormSave<T>(run: () => Promise<T>): Promise<T> {
  requestFormSaves += 1;
  try {
    return await run();
  } finally {
    requestFormSaves -= 1;
  }
}

/** Adds the surface (and request-form) header to a PostgREST call (`/rest/v1/`); anything else is untouched. */
export function withAppSurface(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  const surface = current;
  const formSave = requestFormSaves > 0;
  if (!surface && !formSave) return init;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/rest/v1/")) return init;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (surface) headers.set(APP_SURFACE_HEADER, surface);
  if (formSave) headers.set(REQUEST_FORM_HEADER, "1");
  return { ...init, headers };
}
