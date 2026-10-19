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

/** Adds the surface header to a PostgREST call (`/rest/v1/`) while a surface is set; anything else is untouched. */
export function withAppSurface(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  const surface = current;
  if (!surface) return init;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/rest/v1/")) return init;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set(APP_SURFACE_HEADER, surface);
  return { ...init, headers };
}
