/** Minimal export-only OpenXML workbook. All user text uses shared strings, never formula cells.
 * https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.cell
 * ZIP storage headers follow PKWARE APPNOTE §4.3 (method 0, UTF-8 names, CRC-32).
 */
/** Named cell looks (see `styleDefs` below); `fill` is an optional `#RRGGBB` background override. */
export type ExcelStyleName = "title" | "carHeader" | "time" | "timeMinor" | "ride" | "grid";
export interface ExcelStyledCell { text: string | number | null; style: ExcelStyleName; fill?: string }
export type ExcelCell = string | number | boolean | null | undefined | { excelDate: number } | ExcelStyledCell;
export interface ExcelSheet {
  name: string;
  rows: readonly (readonly ExcelCell[])[];
  /** A1 ranges ("B3:B6") written as `<mergeCells>`; the caller guarantees no overlap. */
  merges?: readonly string[];
  /** Frozen leading rows (default 1 = header row; 0 = none). */
  freezeRows?: number;
  /** Frozen leading columns (default 0). In an RTL sheet these sit on the right. */
  freezeCols?: number;
  /** Per-column widths in characters (default 24 for each). */
  columnWidths?: readonly number[];
  /** Per-row heights in points, by 0-based row index (rows not listed keep the default). */
  rowHeights?: readonly (number | undefined)[];
  /** Style row 1 as the dark header band (default true; the grid sheet styles its own cells). */
  headerRow?: boolean;
  /** Header filter dropdowns over the whole range (default true). */
  autoFilter?: boolean;
}
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const encoder = new TextEncoder();

function escapeXml(value: string): string {
  // XML 1.0 forbids these controls; retain a visible replacement marker.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "�")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}

/** Looks of the named styles: [fontId, borderId, horizontal, vertical, default fill (hex without #) | null]. */
const styleDefs: Record<ExcelStyleName, { font: number; border: number; h: string; v: string; fill: string | null }> = {
  title: { font: 3, border: 3, h: "center", v: "center", fill: "D9E2EC" },
  carHeader: { font: 2, border: 1, h: "center", v: "center", fill: "F0F4F8" },
  time: { font: 2, border: 1, h: "center", v: "top", fill: "F7F9FB" },
  timeMinor: { font: 4, border: 2, h: "center", v: "top", fill: "F7F9FB" },
  ride: { font: 0, border: 1, h: "center", v: "top", fill: null },
  grid: { font: 0, border: 2, h: "center", v: "top", fill: null },
};
const FIXED_XFS = 3;
interface StyleRegistry { xfIndex: (cell: ExcelStyledCell) => number; xfs: string[]; fills: string[] }
function createStyleRegistry(): StyleRegistry {
  const fills: string[] = []; // hex values, fill ids start at 3
  const xfs: string[] = [];
  const indices = new Map<string, number>();
  const fillId = (hex: string | null): number => {
    if (!hex) return 0;
    let i = fills.indexOf(hex);
    if (i < 0) { fills.push(hex); i = fills.length - 1; }
    return 3 + i;
  };
  return {
    fills, xfs,
    xfIndex(cell) {
      const def = styleDefs[cell.style];
      const fill = cell.fill && /^#[0-9a-fA-F]{6}$/.test(cell.fill) ? cell.fill.slice(1).toUpperCase() : def.fill;
      const key = `${cell.style}|${fill ?? ""}`;
      const existing = indices.get(key);
      if (existing !== undefined) return existing;
      const index = FIXED_XFS + xfs.length;
      xfs.push(`<xf numFmtId="0" fontId="${def.font}" fillId="${fillId(fill)}" borderId="${def.border}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="${def.h}" vertical="${def.v}" wrapText="1"/></xf>`);
      indices.set(key, index);
      return index;
    },
  };
}
function cellXml(value: ExcelCell, reference: string, header: boolean, intern: (text: string) => number, styles: StyleRegistry): string {
  if (value === null || value === undefined) return `<c r="${reference}"/>`;
  if (typeof value === "object" && "style" in value) {
    const s = styles.xfIndex(value);
    if (value.text === null || value.text === "") return `<c r="${reference}" s="${s}"/>`;
    if (typeof value.text === "number" && Number.isFinite(value.text)) return `<c r="${reference}" s="${s}"><v>${value.text}</v></c>`;
    const text = String(value.text);
    if (text.length > 32767) throw new Error("spreadsheet_cell_too_long");
    return `<c r="${reference}" t="s" s="${s}"><v>${intern(text)}</v></c>`;
  }
  if (typeof value === "object") {
    if (!Number.isFinite(value.excelDate)) throw new Error("invalid_export_date");
    return `<c r="${reference}" s="2"><v>${value.excelDate}</v></c>`;
  }
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${Number(value)}</v></c>`;
  const text = String(value);
  if (text.length > 32767) throw new Error("spreadsheet_cell_too_long");
  return `<c r="${reference}" t="s"${header ? ' s="1"' : ""}><v>${intern(text)}</v></c>`;
}
function worksheet(sheet: ExcelSheet, intern: (text: string) => number, styles: StyleRegistry): string {
  const width = sheet.rows.reduce((max, row) => Math.max(max, row.length), 1);
  if (width > 16384 || sheet.rows.length > 1048576) throw new Error("spreadsheet_too_large");
  const end = `${columnName(width - 1)}${Math.max(1, sheet.rows.length)}`;
  const columns = Array.from({ length: width }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${sheet.columnWidths?.[i] ?? 24}" customWidth="1"/>`).join("");
  const freezeRows = Math.max(0, Math.floor(sheet.freezeRows ?? 1)), freezeCols = Math.max(0, Math.floor(sheet.freezeCols ?? 0));
  const topLeft = `${columnName(freezeCols)}${freezeRows + 1}`;
  let pane = "";
  if (freezeRows && freezeCols) pane = `<pane xSplit="${freezeCols}" ySplit="${freezeRows}" topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/><selection pane="topRight"/><selection pane="bottomLeft"/><selection pane="bottomRight" activeCell="${topLeft}" sqref="${topLeft}"/>`;
  else if (freezeRows) pane = `<pane ySplit="${freezeRows}" topLeftCell="${topLeft}" activePane="bottomLeft" state="frozen"/>`;
  else if (freezeCols) pane = `<pane xSplit="${freezeCols}" topLeftCell="${topLeft}" activePane="topRight" state="frozen"/>`;
  const headerRow = sheet.headerRow !== false;
  const rows = sheet.rows.map((row, i) => {
    const height = sheet.rowHeights?.[i];
    const attrs = height ? ` ht="${height}" customHeight="1"` : "";
    return `<row r="${i + 1}"${attrs}>${row.map((value, j) => cellXml(value, `${columnName(j)}${i + 1}`, headerRow && i === 0, intern, styles)).join("")}</row>`;
  }).join("");
  const filter = sheet.autoFilter === false ? "" : `<autoFilter ref="A1:${end}"/>`;
  const merges = sheet.merges?.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((ref) => `<mergeCell ref="${escapeXml(ref)}"/>`).join("")}</mergeCells>` : "";
  return `${XML}<worksheet xmlns="${NS}"><dimension ref="A1:${end}"/><sheetViews><sheetView workbookViewId="0" rightToLeft="1">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${columns}</cols><sheetData>${rows}</sheetData>${filter}${merges}</worksheet>`;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}
function concatenate(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function storedZip(entries: readonly { name: string; content: string }[]): Uint8Array<ArrayBuffer> {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name), data = encoder.encode(entry.content), crc = crc32(data);
    const header = new Uint8Array(30), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
    h.setUint16(12, 33, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    local.push(header, name, data);
    const record = new Uint8Array(46), c = new DataView(record.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
    c.setUint16(14, 33, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(record, name);
    offset += header.length + name.length + data.length;
  }
  const directory = concatenate(central), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, directory.length, true); e.setUint32(16, offset, true);
  return concatenate([...local, directory, end]);
}

/** No macro, external-link, formula, or import support. Strings stay literal even when beginning with =,+,-,@. */
export function createXlsx(sheets: readonly ExcelSheet[]): Uint8Array<ArrayBuffer> {
  if (!sheets.length || new Set(sheets.map((s) => s.name.toLowerCase())).size !== sheets.length || sheets.some((s) => !s.name || s.name.length > 31 || [...s.name].some((char) => "\\/?*[]:".includes(char)))) throw new Error("invalid_export_sheets");
  const strings: string[] = [];
  const indices = new Map<string, number>();
  let stringCount = 0;
  const intern = (text: string): number => {
    stringCount++;
    const existing = indices.get(text);
    if (existing !== undefined) return existing;
    const index = strings.length;
    indices.set(text, index);
    strings.push(text);
    return index;
  };
  const styleRegistry = createStyleRegistry();
  const worksheets = sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: worksheet(sheet, intern, styleRegistry) }));
  // ST_Xstring escapes: protect literal _xNNNN_ text before encoding carriage returns.
  const sharedStrings = `${XML}<sst xmlns="${NS}" count="${stringCount}" uniqueCount="${strings.length}">${strings.map((text) => `<si><t xml:space="preserve">${escapeXml(text.replace(/_x([0-9a-fA-F]{4})_/g, "_x005F_x$1_").replace(/\r/g, "_x000D_"))}</t></si>`).join("")}</sst>`;
  const solidFill = (hex: string) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}"/><bgColor indexed="64"/></patternFill></fill>`;
  const edge = (side: string, style: string, color: string) => `<${side} style="${style}"><color rgb="FF${color}"/></${side}>`;
  const box = (style: string, color: string) => `<border>${edge("left", style, color)}${edge("right", style, color)}${edge("top", style, color)}${edge("bottom", style, color)}<diagonal/></border>`;
  const styles = `${XML}<styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/></numFmts><fonts count="5"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font><font><b/><sz val="14"/><name val="Arial"/></font><font><sz val="8"/><color rgb="FF627D98"/><name val="Arial"/></font></fonts><fills count="${3 + styleRegistry.fills.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${solidFill("243B53")}${styleRegistry.fills.map(solidFill).join("")}</fills><borders count="4"><border><left/><right/><top/><bottom/><diagonal/></border>${box("thin", "829AB1")}${box("hair", "BCCCDC")}<border>${edge("left", "thin", "829AB1")}${edge("right", "thin", "829AB1")}${edge("top", "thick", "243B53")}${edge("bottom", "thin", "829AB1")}<diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${FIXED_XFS + styleRegistry.xfs.length}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>${styleRegistry.xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return storedZip([
    { name: "[Content_Types].xml", content: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", content: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets>${sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="sharedStrings" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="styles" Type="${REL}/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: styles },
    { name: "xl/sharedStrings.xml", content: sharedStrings },
    ...worksheets,
  ]);
}
