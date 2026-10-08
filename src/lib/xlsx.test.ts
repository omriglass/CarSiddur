import { describe, expect, it } from "vitest";
import { createXlsx } from "./xlsx";

/** Independent ZIP local-header reader; method-0 files are directly inspectable. */
export function unzipStored(bytes: Uint8Array): Map<string, string> {
  const entries = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    expect(view.getUint16(offset + 8, true)).toBe(0);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const start = offset + 30;
    const name = new TextDecoder().decode(bytes.slice(start, start + nameLength));
    const dataStart = start + nameLength + extraLength;
    entries.set(name, new TextDecoder().decode(bytes.slice(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  expect(view.getUint32(offset, true)).toBe(0x02014b50);
  return entries;
}

describe("export-only XLSX", () => {
  it("packages Hebrew, XML special characters, literal escape sequences, and typed dates", () => {
    const files = unzipStored(createXlsx([{ name: "בדיקה", rows: [["שם", "זמן"], ["נבו <שלום> & _x0041_", { excelDate: 45000.5 }]] }]));
    expect(files.has("[Content_Types].xml")).toBe(true);
    expect(files.get("xl/workbook.xml")).toContain('name="בדיקה"');
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    expect(files.get("xl/sharedStrings.xml")).toContain("נבו &lt;שלום&gt; &amp; _x005F_x0041_");
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toContain('<c r="B2" s="2"><v>45000.5</v></c>');
    expect(files.get("xl/styles.xml")).toContain('formatCode="dd/mm/yyyy hh:mm"');
  });

  it("keeps formula-injection payloads as literal strings and creates no formulas or external links", () => {
    const attacks = ['=HYPERLINK("https://example.invalid", "click")', '+SUM(1,2)', '-2+3', '@SUM(A1)', '\t=cmd|test', '</t></is><f>1+1</f>'];
    const files = unzipStored(createXlsx([{ name: "data", rows: [["notes"], ...attacks.map((text) => [text])] }]));
    const xml = files.get("xl/worksheets/sheet1.xml")!;
    expect(xml.match(/t="s"/g)).toHaveLength(attacks.length + 1);
    expect(xml).not.toContain("<f>");
    expect(xml).not.toContain("<hyperlink");
    expect(files.get("xl/sharedStrings.xml")).not.toContain("<f>");
    expect([...files.keys()].some((name) => name.includes("externalLink"))).toBe(false);
  });

  it("reuses literal strings across sheets and protects carriage returns from XML normalization", () => {
    const files = unzipStored(createXlsx([
      { name: "first", rows: [["same", "a\r\nb"]] },
      { name: "second", rows: [["same"]] },
    ]));
    expect(files.get("xl/sharedStrings.xml")).toContain('count="3" uniqueCount="2"');
    expect(files.get("xl/sharedStrings.xml")).toContain("a_x000D_\nb");
    expect(files.get("xl/worksheets/sheet2.xml")).toContain('<c r="A1" t="s" s="1"><v>0</v></c>');
  });

  it("rejects duplicate names and excessive cells instead of producing a corrupt or truncated workbook", () => {
    expect(() => createXlsx([{ name: "data", rows: [] }, { name: "DATA", rows: [] }])).toThrow();
    expect(() => createXlsx([{ name: "data", rows: [["x".repeat(32768)]] }])).toThrow("spreadsheet_cell_too_long");
  });
});

describe("xlsx sheet options", () => {
  const sheet = { name: "grid", rows: [[{ text: "T", style: "title" as const }, { text: null, style: "title" as const }], [{ text: "a", style: "ride" as const, fill: "#C9CEEA" }, { text: "b", style: "ride" as const, fill: "#C9CEEA" }]],
    merges: ["A1:B1"], freezeRows: 2, freezeCols: 1, columnWidths: [4, 20], rowHeights: [24, 15], autoFilter: false, headerRow: false };
  it("writes merges, freeze pane, widths, heights and per-style xfs without a filter", () => {
    const files = unzipStored(createXlsx([sheet]));
    const xml = files.get("xl/worksheets/sheet1.xml")!;
    expect(xml).toContain('<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>');
    expect(xml).toContain('<pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/>');
    expect(xml).toContain('<col min="1" max="1" width="4" customWidth="1"/>');
    expect(xml).toContain('<row r="1" ht="24" customHeight="1">');
    expect(xml).not.toContain("autoFilter");
    const styles = files.get("xl/styles.xml")!;
    expect(styles).toContain('<cellXfs count="5">'); // 3 fixed + title(default fill) + ride(custom fill)
    expect(styles).toContain('<fills count="5">');
    expect(styles).toContain("FFC9CEEA");
  });
  it("keeps the default single frozen header row and filter for plain sheets", () => {
    const xml = unzipStored(createXlsx([{ name: "p", rows: [["h"], ["v"]] }])).get("xl/worksheets/sheet1.xml")!;
    expect(xml).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(xml).toContain('<autoFilter ref="A1:A2"/>');
  });
});
