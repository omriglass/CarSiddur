import { describe, expect, it } from "vitest";

import { TAB_ID_HEADER, tabId, withTabId } from "./tabId";

describe("withTabId", () => {
  it("marks database calls with this page's id, keeping their headers", () => {
    const out = withTabId("http://x/rest/v1/rpc/edit_ride", { headers: { apikey: "k" } });
    const headers = new Headers(out?.headers);
    expect(headers.get(TAB_ID_HEADER)).toBe(tabId());
    expect(headers.get("apikey")).toBe("k");
  });

  it("never marks auth or function calls", () => {
    const init = { headers: { apikey: "k" } };
    expect(withTabId("http://x/auth/v1/token", init)).toBe(init);
    expect(withTabId(new URL("http://x/functions/v1/answer-proposal"), init)).toBe(init);
  });

  it("is one stable id per page load", () => {
    expect(tabId()).toBe(tabId());
    expect(tabId().length).toBeGreaterThan(8);
  });
});
