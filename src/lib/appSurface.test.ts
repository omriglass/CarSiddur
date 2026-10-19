import { afterEach, describe, expect, it } from "vitest";

import { APP_SURFACE_HEADER, setAppSurface, withAppSurface } from "./appSurface";

describe("withAppSurface", () => {
  afterEach(() => setAppSurface(null));

  it("leaves calls alone while no surface is set", () => {
    const init = { method: "POST" };
    expect(withAppSurface("http://x/rest/v1/rpc/edit_ride", init)).toBe(init);
  });

  it("marks database calls made from the board, keeping their headers", () => {
    setAppSurface("board");
    const out = withAppSurface("http://x/rest/v1/rpc/edit_ride", { headers: { apikey: "k" } });
    const headers = new Headers(out?.headers);
    expect(headers.get(APP_SURFACE_HEADER)).toBe("board");
    expect(headers.get("apikey")).toBe("k");
  });

  it("never marks auth or function calls", () => {
    setAppSurface("board");
    const init = { method: "POST" };
    expect(withAppSurface("http://x/auth/v1/token", init)).toBe(init);
    expect(withAppSurface(new URL("http://x/functions/v1/answer-proposal"), init)).toBe(init);
  });
});
