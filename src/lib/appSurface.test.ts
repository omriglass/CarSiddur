import { afterEach, describe, expect, it } from "vitest";

import { APP_SURFACE_HEADER, FREED_CAR_HEADER, REQUEST_FORM_HEADER, asRequestFormSave, setAppSurface, withAppSurface, withFreedCarChoice } from "./appSurface";

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

  it("marks the calls of a request-form save until it settles (REQ §13.169)", async () => {
    let inside: string | null = null;
    await asRequestFormSave(async () => {
      inside = new Headers(withAppSurface("http://x/rest/v1/rpc/submit_request", {})?.headers).get(REQUEST_FORM_HEADER);
    });
    expect(inside).toBe("1");
    const init = { method: "POST" };
    expect(withAppSurface("http://x/rest/v1/rpc/submit_request", init)).toBe(init);
  });

  it("keeps the header count right when a save fails", async () => {
    await expect(asRequestFormSave(async () => { throw new Error("x"); })).rejects.toThrow("x");
    const init = {};
    expect(withAppSurface("http://x/rest/v1/rpc/submit_request", init)).toBe(init);
  });

  it("marks the calls of a save that keeps the freed car out, read per call, and stops after it (REQ item 237)", async () => {
    const url = "http://x/rest/v1/rpc/cancel_ride";
    const keepOf = () => new Headers(withAppSurface(url, {})?.headers).get(FREED_CAR_HEADER);
    let chosen = false;
    const seen: (string | null)[] = [];
    await withFreedCarChoice(() => chosen, async () => {
      seen.push(keepOf());
      chosen = true;
      seen.push(keepOf());
    });
    expect(seen).toEqual([null, "keep"]);
    const init = {};
    expect(withAppSurface(url, init)).toBe(init);
    await expect(withFreedCarChoice(true, async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(withAppSurface(url, init)).toBe(init);
  });
});
