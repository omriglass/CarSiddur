import { describe, expect, it } from "vitest";

import { proposalPreviewText, proposalTemplateVariant, timeChangeLine, type ProposalTextInput } from "./proposalText";

const base: ProposalTextInput = {
  template: { body: "a {{depart}}\n{{timeChange}}{{carLine}}\nlink" },
  type: "shift",
  request: { depart_at: "2026-09-13T06:00:00.000Z", return_at: "2026-09-13T12:00:00.000Z" },
  requesterName: "Dan Cohen", sadranName: "S", destinationName: "", route: "", carName: "Kia",
  origin: "", newOrigin: "", driverName: "", reason: "", externalSuggestion: "",
};

describe("proposalPreviewText shift", () => {
  it("does not phrase unchanged times as a change", () => {
    const text = proposalPreviewText({ ...base, proposedDepartAt: base.request!.depart_at, proposedReturnAt: base.request!.return_at });
    expect(text).not.toContain("במקום");
    expect(text).toContain("Kia");
  });
  it("states only the changed part, old -> new", () => {
    const text = proposalPreviewText({ ...base, proposedDepartAt: "2026-09-13T07:00:00.000Z", proposedReturnAt: base.request!.return_at });
    expect(text).toContain("במקום 09:00");
    expect(text).not.toContain("חזרה");
  });
  it("names the days for a series span", () => {
    const text = proposalPreviewText({
      ...base, proposedDepartAt: "2026-09-13T06:00:00.000Z", proposedReturnAt: "2026-09-14T12:00:00.000Z",
      seriesOriginal: { departAt: "2026-09-13T06:00:00.000Z", returnAt: "2026-09-15T12:00:00.000Z" },
    });
    expect(text).toContain("חזרה ביום");
  });
});

describe("timeChangeLine", () => {
  it("is empty when nothing changes", () => {
    expect(timeChangeLine({ depart: "2026-09-13T06:00:00.000Z" }, { depart: "2026-09-13T06:00:00.000Z" })).toBe("");
  });
});

describe("proposalTemplateVariant - R5B11 same times", () => {
  it("an unplaced member offered only a car gets the same-times variant", () => {
    expect(proposalTemplateVariant("shift", { car_id: "c" }, { timesUnchanged: true })).toBe("shift_same_times");
  });
  it("not when placed, when a time changes, or for a fewer-days span", () => {
    expect(proposalTemplateVariant("shift", { car_id: "c" }, { timesUnchanged: true, placed: true })).toBe("shift_placed");
    expect(proposalTemplateVariant("shift", { car_id: "c" }, { timesUnchanged: false })).toBe("shift");
    expect(proposalTemplateVariant("shift", { car_id: "c", series_span: {} }, { timesUnchanged: true })).toBe("shift");
    expect(proposalTemplateVariant("shift", {}, { timesUnchanged: true })).toBe("shift");
  });
});

describe("proposalTemplateVariant", () => {
  it("has two external variants and no own-car one", () => {
    expect(proposalTemplateVariant("external", {})).toBe("external_none");
    expect(proposalTemplateVariant("external", { external_reason: "city" })).toBe("external_city");
    expect(proposalTemplateVariant("merge")).toBe("merge_passenger");
  });
});

describe("QA run 2 copy (REQ §13.102 R2B10)", () => {
  it("never prints an empty old value: no old time -> new only", () => {
    const line = timeChangeLine({ return: null }, { return: "2026-09-13T11:30:00.000Z" });
    expect(line).toContain("14:30");
    expect(line).not.toContain("במקום");
  });
  it("renders the window without a dangling dash and the reason before the link", () => {
    const text = proposalPreviewText({
      ...base, type: "external", reason: "אין רכב", request: { depart_at: "2026-09-13T06:00:00.000Z", return_at: null },
      template: { body: "{{window}}\n{{reasonNote}}שאלה\n{{link}}" },
    });
    expect(text.split("\n")[0]).toBe("09:00");
    expect(text.indexOf("אין רכב")).toBeLessThan(text.indexOf("{{link}}"));
  });
  it("picks the city-home and placed variants", () => {
    expect(proposalTemplateVariant("external", { external_reason: "city" }, { destinationIsHome: true })).toBe("external_city_home");
    expect(proposalTemplateVariant("shift", null, { placed: true })).toBe("shift_placed");
  });
});
