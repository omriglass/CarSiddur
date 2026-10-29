import { describe, expect, it } from "vitest";

import { weekExportFileName } from "./weekFileName";

describe("weekExportFileName", () => {
  it("names the department and the week's Sunday-Saturday dates", () => {
    expect(weekExportFileName("נבו", "2026-11-01")).toBe("סידור נבו - 1.11-7.11 (2026).xlsx");
  });

  it("crosses a month and a year end", () => {
    expect(weekExportFileName("נבו", "2026-12-27")).toBe("סידור נבו - 27.12-2.1 (2026).xlsx");
  });

  it("drops characters a file name cannot hold", () => {
    expect(weekExportFileName("א/ב", "2026-11-01")).toBe("סידור א-ב - 1.11-7.11 (2026).xlsx");
  });
});
