// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { isDocumentScroller, pageScroller, scrollerViewport } from "./pageScroller";

afterEach(() => { document.body.innerHTML = ""; });

describe("pageScroller", () => {
  it("falls back to the document scroller when no ancestor scrolls", () => {
    document.body.innerHTML = '<main id="main-content" style="overflow-x: clip"><div id="box"></div></main>';
    const scroller = pageScroller(document.getElementById("box"));
    expect(scroller).not.toBeNull();
    expect(isDocumentScroller(scroller!)).toBe(true);
    expect(scrollerViewport(scroller!).top).toBe(0);
  });

  it("returns a bounded overflow-y ancestor that really scrolls", () => {
    document.body.innerHTML = '<main id="main-content" style="overflow-y: auto"><div id="box"></div></main>';
    const main = document.getElementById("main-content")!;
    Object.defineProperty(main, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(main, "clientHeight", { configurable: true, value: 600 });
    expect(pageScroller(document.getElementById("box"))).toBe(main);
  });

  it("skips an overflow-y ancestor that cannot scroll", () => {
    document.body.innerHTML = '<main style="overflow-y: auto"><div id="box"></div></main>';
    expect(isDocumentScroller(pageScroller(document.getElementById("box"))!)).toBe(true);
  });
});
