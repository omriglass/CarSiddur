import { beforeEach, describe, expect, it, vi } from "vitest";

import { findFirstInvalidElement, focusInvalidElement, scrollToFirstInvalid } from "./useScrollToFirstError";

/** jsdom's `getBoundingClientRect` always returns zeros; fake a `top` per element from `data-top` so "topmost" is meaningful in these tests. */
function stubRectsByDataTop() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const top = Number(this.getAttribute("data-top") ?? "0");
    return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  stubRectsByDataTop();
});

describe("findFirstInvalidElement", () => {
  it("picks the topmost element among matched error keys", () => {
    document.body.innerHTML = `
      <form>
        <div data-field="b" data-top="10"></div>
        <div data-field="a" data-top="30"></div>
      </form>
    `;
    const form = document.querySelector("form")!;
    const el = findFirstInvalidElement(form, { a: { type: "required" }, b: { type: "required" } } as never);
    expect(el?.getAttribute("data-field")).toBe("b");
  });

  it("matches by name attribute when there is no data-field", () => {
    document.body.innerHTML = `<form><input name="destination" data-top="5" /></form>`;
    const form = document.querySelector("form")!;
    const el = findFirstInvalidElement(form, { destination: { type: "required" } } as never);
    expect(el?.tagName).toBe("INPUT");
  });

  it("falls back to the top-level segment for nested/array field names", () => {
    document.body.innerHTML = `<form><div data-field="children" data-top="0"></div></form>`;
    const form = document.querySelector("form")!;
    const el = findFirstInvalidElement(form, { "children.0.name": { type: "required" } } as never);
    expect(el?.getAttribute("data-field")).toBe("children");
  });

  it("falls back to the topmost [aria-invalid=true] when no error key resolves to an element", () => {
    document.body.innerHTML = `
      <form>
        <input name="untracked-a" aria-invalid="true" data-top="20" />
        <input name="untracked-b" aria-invalid="true" data-top="4" />
      </form>
    `;
    const form = document.querySelector("form")!;
    const el = findFirstInvalidElement(form, { somethingElse: { type: "required" } } as never);
    expect(el?.getAttribute("name")).toBe("untracked-b");
  });

  it("returns null when nothing matches", () => {
    document.body.innerHTML = `<form></form>`;
    const form = document.querySelector("form")!;
    expect(findFirstInvalidElement(form, { a: { type: "required" } } as never)).toBeNull();
  });
});

describe("focusInvalidElement", () => {
  it("focuses a naturally focusable element directly", () => {
    document.body.innerHTML = `<form><input name="destination" /></form>`;
    const input = document.querySelector("input")!;
    focusInvalidElement(input);
    expect(input.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(document.activeElement).toBe(input);
  });

  it("focuses the first focusable descendant when the matched element itself isn't focusable", () => {
    document.body.innerHTML = `
      <div data-field="day">
        <span>label</span>
        <button type="button">Sunday</button>
      </div>
    `;
    const wrapper = document.querySelector('[data-field="day"]')! as HTMLElement;
    focusInvalidElement(wrapper);
    expect(document.activeElement?.tagName).toBe("BUTTON");
  });

  it("falls back to making the element itself focusable with tabIndex=-1", () => {
    document.body.innerHTML = `<div data-field="tripShape"><span>no focusable children</span></div>`;
    const wrapper = document.querySelector('[data-field="tripShape"]')! as HTMLElement;
    focusInvalidElement(wrapper);
    expect(wrapper.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(wrapper);
  });
});

describe("scrollToFirstInvalid", () => {
  it("finds and focuses the first invalid field in one call", () => {
    document.body.innerHTML = `<form><input name="destination" data-top="0" /></form>`;
    const form = document.querySelector("form")!;
    const input = document.querySelector("input")!;
    scrollToFirstInvalid(form, { destination: { type: "required" } } as never);
    expect(document.activeElement).toBe(input);
  });

  it("does nothing when there is no invalid element", () => {
    document.body.innerHTML = `<form></form>`;
    const form = document.querySelector("form")!;
    expect(() => scrollToFirstInvalid(form, {} as never)).not.toThrow();
  });
});
