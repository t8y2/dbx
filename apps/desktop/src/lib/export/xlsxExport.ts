export type XlsxCellValue = string | number | boolean | null | undefined;

export interface XlsxWorksheetData {
  sheetName?: string;
  columns: readonly string[];
  columnTypes?: readonly string[];
  rows: readonly (readonly XlsxCellValue[])[];
}

type ZipEntry = {
  path: string;
  data: Uint8Array;
  crc: number;
  localHeaderOffset: number;
};

const encoder = new TextEncoder();
const CRC_TABLE = buildCrcTable();

function buildCrcTable(): number[] {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table.push(c >>> 0);
  }
  return table;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(value: string): string {
  return [...value]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index: number): string {
  let value = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    value = String.fromCharCode(65 + rem) + value;
    n = Math.floor((n - 1) / 26);
  }
  return value;
}

function cellRef(rowIndex: number, colIndex: number): string {
  return `${columnName(colIndex)}${rowIndex + 1}`;
}

function sheetRange(columnCount: number, rowCount: number): string {
  if (columnCount === 0 || rowCount === 0) return "A1";
  return `A1:${columnName(columnCount - 1)}${rowCount}`;
}

function normalizeSheetName(value?: string): string {
  const invalidChars = new Set(["[", "]", ":", "*", "?", "/", "\\"]);
  const name =
    [...(value || "Sheet1")]
      .map((char) => (invalidChars.has(char) ? " " : char))
      .join("")
      .trim() || "Sheet1";
  return name.slice(0, 31);
}

function normalizeUniqueSheetNames(sheets: readonly XlsxWorksheetData[]): string[] {
  const names: string[] = [];
  sheets.forEach((sheet, index) => {
    const base = normalizeSheetName(sheet.sheetName || `Sheet${index + 1}`);
    let candidate = base;
    let suffix = 2;
    while (names.includes(candidate)) {
      const suffixText = ` (${suffix})`;
      candidate = `${base.slice(0, 31 - suffixText.length)}${suffixText}`;
      suffix += 1;
    }
    names.push(candidate);
  });
  return names;
}

function estimateColumnWidths(columns: readonly string[], rows: readonly (readonly XlsxCellValue[])[]): number[] {
  return columns.map((column, colIndex) => {
    const values = rows.slice(0, 100).map((row) => row[colIndex]);
    const maxLen = [column, ...values.map((value) => (value == null ? "" : String(value)))].map((value) => Math.min(value.length, 60)).reduce((max, length) => Math.max(max, length), 8);
    return Math.max(10, Math.min(60, maxLen + 2));
  });
}

function isNumericColumnType(columnType?: string): boolean {
  const base = (columnType || "")
    .trim()
    .toLowerCase()
    .split(/[\s([]/, 1)[0];
  return new Set([
    "bit",
    "tinyint",
    "smallint",
    "mediumint",
    "int",
    "integer",
    "bigint",
    "int2",
    "int4",
    "int8",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
    "uint128",
    "uint256",
    "float",
    "float4",
    "float8",
    "float32",
    "float64",
    "real",
    "double",
    "decimal",
    "numeric",
    "number",
    "money",
    "smallmoney",
  ]).has(base);
}

function safeExcelNumber(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || !Number.isFinite(Number(trimmed))) return undefined;
  const significantDigits = (trimmed.split(/[eE]/, 1)[0].match(/\d/g) || []).join("").replace(/^0+/, "").length;
  return significantDigits <= 15 ? trimmed : undefined;
}

function cellXml(value: XlsxCellValue, rowIndex: number, colIndex: number, style?: number, columnType?: string): string {
  const ref = cellRef(rowIndex, colIndex);
  const styleAttr = style == null ? "" : ` s="${style}"`;
  if (value == null) return `<c r="${ref}"${styleAttr}/>`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${ref}" t="b"${styleAttr}><v>${value ? 1 : 0}</v></c>`;
  }
  if (typeof value === "string" && isNumericColumnType(columnType)) {
    // Excel keeps only 15 significant digits, so preserve higher-precision
    // database values as text rather than silently rounding them.
    const number = safeExcelNumber(value);
    if (number !== undefined) return `<c r="${ref}"${styleAttr}><v>${number}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t>${escapeXml(String(value))}</t></is></c>`;
}

function worksheetXml(data: XlsxWorksheetData): string {
  const columns = data.columns;
  const rows = data.rows;
  const totalRows = rows.length + 1;
  const range = sheetRange(columns.length, totalRows);
  const widths = estimateColumnWidths(columns, rows);
  const colsXml = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  const headerXml = `<row r="1">${columns.map((column, index) => cellXml(column, 0, index, 1)).join("")}</row>`;
  const bodyXml = rows
    .map((row, rowIndex) => {
      const excelRowIndex = rowIndex + 2;
      const cells = columns.map((_, colIndex) => cellXml(row[colIndex], excelRowIndex - 1, colIndex, undefined, data.columnTypes?.[colIndex])).join("");
      return `<row r="${excelRowIndex}">${cells}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${range}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${colsXml}</cols>
  <sheetData>${headerXml}${bodyXml}</sheetData>
  <autoFilter ref="${range}"/>
</worksheet>`;
}

function contentTypesXml(sheetCount = 1): string {
  const worksheetOverrides = Array.from({ length: sheetCount }, (_, index) => `  <Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${worksheetOverrides}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
}

function rootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function workbookXml(sheetNames: readonly string[]): string {
  const sheets = sheetNames.map((sheetName, index) => `<sheet name="${escapeXml(sheetName)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheets}</sheets>
</workbook>`;
}

function workbookRelsXml(sheetCount = 1): string {
  const worksheetRels = Array.from({ length: sheetCount }, (_, index) => `  <Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${worksheetRels}
  <Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function uint16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, value, true);
  return bytes;
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, value >>> 0, true);
  return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function createZip(files: Array<{ path: string; content: string }>): Uint8Array {
  const entries: ZipEntry[] = [];
  const localParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const path = encoder.encode(file.path);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const localHeader = concatBytes([uint32(0x04034b50), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0), uint32(crc), uint32(data.length), uint32(data.length), uint16(path.length), uint16(0), path]);
    entries.push({ path: file.path, data, crc, localHeaderOffset: offset });
    localParts.push(localHeader, data);
    offset += localHeader.length + data.length;
  }

  const centralParts: Uint8Array[] = [];
  for (const entry of entries) {
    const path = encoder.encode(entry.path);
    centralParts.push(
      concatBytes([uint32(0x02014b50), uint16(20), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0), uint32(entry.crc), uint32(entry.data.length), uint32(entry.data.length), uint16(path.length), uint16(0), uint16(0), uint16(0), uint16(0), uint32(0), uint32(entry.localHeaderOffset), path]),
    );
  }

  const central = concatBytes(centralParts);
  const end = concatBytes([uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length), uint32(central.length), uint32(offset), uint16(0)]);

  return concatBytes([...localParts, central, end]);
}

export function buildXlsxWorkbook(data: XlsxWorksheetData): Uint8Array {
  return buildXlsxWorkbookMulti([data]);
}

export function buildXlsxWorkbookMulti(sheets: readonly XlsxWorksheetData[]): Uint8Array {
  if (sheets.length === 0) throw new Error("At least one worksheet is required");
  const sheetNames = normalizeUniqueSheetNames(sheets);
  return createZip([
    { path: "[Content_Types].xml", content: contentTypesXml(sheets.length) },
    { path: "_rels/.rels", content: rootRelsXml() },
    { path: "xl/workbook.xml", content: workbookXml(sheetNames) },
    { path: "xl/_rels/workbook.xml.rels", content: workbookRelsXml(sheets.length) },
    { path: "xl/styles.xml", content: stylesXml() },
    ...sheets.map((sheet, index) => ({ path: `xl/worksheets/sheet${index + 1}.xml`, content: worksheetXml(sheet) })),
  ]);
}
