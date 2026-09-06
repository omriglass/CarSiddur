import { describe, expect, it } from "vitest";

import { buildWaUrl, renderTemplate, toWaDigits } from "./waLink";

describe("renderTemplate", () => {
  it("fills every placeholder present in vars", () => {
    const text = "היי {{firstName}}, {{sadranName}} מסידור הרכב";
    expect(renderTemplate(text, { firstName: "דנה", sadranName: "מיכל" })).toBe(
      "היי דנה, מיכל מסידור הרכב",
    );
  });

  it("leaves an unmatched placeholder untouched instead of dropping it", () => {
    const text = "עד {{expiresAt}}: {{link}}";
    expect(renderTemplate(text, { link: "https://x/p/abc" })).toBe("עד {{expiresAt}}: https://x/p/abc");
  });

  it("fills the same placeholder repeated more than once", () => {
    expect(renderTemplate("{{x}} and {{x}}", { x: "1" })).toBe("1 and 1");
  });
});

describe("toWaDigits", () => {
  it("strips the leading + from an E.164 number", () => {
    expect(toWaDigits("+972501234567")).toBe("972501234567");
  });

  it("strips any non-digit characters", () => {
    expect(toWaDigits("+972 50-123 4567")).toBe("972501234567");
  });
});

describe("buildWaUrl", () => {
  it("builds a wa.me URL with digits-only phone and URL-encoded text", () => {
    const url = buildWaUrl("+972501234567", "היי דנה\nשלום");
    expect(url.startsWith("https://wa.me/972501234567?text=")).toBe(true);
    const encodedPart = url.split("?text=")[1] ?? "";
    expect(decodeURIComponent(encodedPart)).toBe("היי דנה\nשלום");
  });

  it("never includes a literal '+' in the phone segment", () => {
    const url = buildWaUrl("+972501234567", "x");
    const phoneSegment = url.replace("https://wa.me/", "").split("?")[0];
    expect(phoneSegment).not.toContain("+");
    expect(phoneSegment).toBe("972501234567");
  });
});
