import type { DataDictionaryLabels, DictionaryLayout, DictionaryTable } from "@/lib/docs/dataDictionary";
import { columnComment, qualifiedObjectName, typeLabel } from "@/lib/docs/dataDictionary";

const CM = 28.3464567;
const INK = "0.16 0.16 0.16";
const MUTED = "0.38 0.38 0.38";
const ORANGE = "0.91 0.44 0.08";
const BROWN = "0.35 0.18 0.06";
const PEACH = "0.99 0.88 0.74";
const GRID = "0.90 0.50 0.18";
const CHECK = "\u0001";

const PAPER: Record<DictionaryLayout["paper"], { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  A3: { width: 841.89, height: 1190.55 },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 },
};

interface Page {
  commands: string[];
  bookmark?: string;
}

interface PlacedObject {
  table: DictionaryTable;
  page: number;
}

interface TocEntry {
  label: string;
  page: number;
  indent: number;
}

export function pdfUtf16Hex(text: string): string {
  let hex = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0xffff) {
      const adjusted = code - 0x10000;
      hex += (0xd800 + (adjusted >> 10)).toString(16).padStart(4, "0");
      hex += (0xdc00 + (adjusted & 0x3ff)).toString(16).padStart(4, "0");
    } else {
      hex += code.toString(16).padStart(4, "0");
    }
  }
  return hex.toUpperCase();
}

export function buildDataDictionaryPdf(tables: DictionaryTable[], labels: DataDictionaryLabels, layout: DictionaryLayout, warnings: string[] = []): Uint8Array {
  const page = pageSize(layout);
  const margin = clamp(layout.marginCm, 0.5, 4) * CM;
  const includeIntro = layout.includeIntroduction && layout.introduction.trim() !== "";
  const intro = includeIntro ? flowLines(layout.introduction.split(/\n+/), page, margin, layout.bodySize, introHeading(labels)) : [];
  const body = flowObjects(tables, labels, layout, page, margin);
  const notes = warnings.length ? flowLines(warnings, page, margin, layout.bodySize) : [];
  const toc = layout.includeToc ? renderToc(tocFor(labels, tables, body.placed, intro.length), labels, page, margin, layout.bodySize) : [];
  const cover = layout.includeCover ? [coverPage(layout, page, margin)] : [];
  // Page numbers start at the introduction so TOC entries (numbered from the
  // introduction) match the printed footers; cover and contents stay unnumbered.
  const frontCount = cover.length + toc.length;
  const pages = [...cover, ...toc, ...intro, ...body.pages, ...notes];
  if (pages.length === 0) pages.push({ commands: [] });
  stampChrome(pages, layout, page, margin, frontCount);
  return encodePdf(pages, page, layout.title || "Data Dictionary");
}

function pageSize(layout: DictionaryLayout): { width: number; height: number } {
  const paper = PAPER[layout.paper];
  return layout.orientation === "landscape" ? { width: paper.height, height: paper.width } : paper;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function charWidth(char: string, size: number): number {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 128) return size;
  if ("ilj.,:;!'|".includes(char)) return size * 0.28;
  if (char === " ") return size * 0.28;
  if ("mwMW@%".includes(char)) return size * 0.78;
  return size * 0.52;
}

function textWidth(text: string, size: number): number {
  let width = 0;
  for (const char of text) width += charWidth(char, size);
  return width;
}

function wrap(text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const char of text) {
    const next = line + char;
    if (line && textWidth(next, size) > width) {
      lines.push(line);
      line = char;
    } else {
      line = next;
    }
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

function fill(x: number, y: number, width: number, height: number, color: string): string {
  return `${color} rg ${num(x)} ${num(y)} ${num(width)} ${num(height)} re f`;
}

function coverPage(layout: DictionaryLayout, page: { width: number; height: number }, margin: number): Page {
  const commands: string[] = [];
  let y = page.height * 0.62;
  const titleSize = Math.max(28, layout.headingSize + 16);
  for (const line of wrap(layout.title || "Data Dictionary", titleSize, page.width - margin * 2)) {
    commands.push(textOp(margin, y, titleSize, line, ORANGE));
    y -= titleSize + 6;
  }
  y -= 4;
  const second = layout.subtitle.trim() || "数据字典";
  commands.push(textOp(margin, y, layout.headingSize + 6, second, BROWN));
  y -= layout.headingSize + 28;
  const meta = [layout.header, layout.remarks, layout.coverFooter].filter((line) => line && line !== layout.title && line !== second);
  for (const line of meta) {
    commands.push(textOp(margin, y, layout.bodySize + 1, line, INK));
    y -= layout.bodySize + 8;
  }
  coverShapes(commands, page.width, 0);
  return { commands };
}

function coverShapes(commands: string[], pageWidth: number, bottom: number): void {
  const shades = [ORANGE, "0.96 0.62 0.22", "0.98 0.78 0.45", "0.93 0.55 0.16"];
  const tiles = [
    [pageWidth * 0.08, bottom + 36, 92, 64, -18],
    [pageWidth * 0.28, bottom + 18, 110, 72, -12],
    [pageWidth * 0.48, bottom + 48, 120, 70, -8],
    [pageWidth * 0.66, bottom + 12, 100, 68, -16],
    [pageWidth * 0.82, bottom + 40, 90, 60, -10],
  ] as const;
  tiles.forEach(([x, y, width, height, degrees], index) => {
    commands.push(rotatedFill(x, y, width, height, degrees, shades[index % shades.length]!));
  });
}

function rotatedFill(x: number, y: number, width: number, height: number, degrees: number, color: string): string {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return `q ${color} rg ${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(x)} ${num(y)} cm 0 0 ${num(width)} ${num(height)} re f Q`;
}

function introHeading(labels: DataDictionaryLabels): string {
  return labels.contentsHeading === "目录" ? "1. 引言" : "1. Introduction";
}

function tocFor(labels: DataDictionaryLabels, tables: DictionaryTable[], placed: PlacedObject[], introPages: number): TocEntry[] {
  const entries: TocEntry[] = [];
  let section = 1;
  if (introPages > 0) {
    entries.push({ label: introHeading(labels), page: 1, indent: 0 });
    section = 2;
  }
  const seen = new Set<string>();
  for (const item of placed) {
    const database = item.table.database || labels.kindTable;
    if (!seen.has(database)) {
      seen.add(database);
      entries.push({ label: `${section}. ${database}`, page: introPages + item.page + 1, indent: 0 });
      section += 1;
    }
    entries.push({ label: `${labels.kindTable}: ${item.table.name}`, page: introPages + item.page + 1, indent: 2 });
  }
  if (entries.length === 0 && tables.length === 0) entries.push({ label: labels.contentsHeading, page: 1, indent: 0 });
  return entries;
}

function tocLineHeight(body: number): number {
  return body + 10;
}

function renderToc(entries: TocEntry[], labels: DataDictionaryLabels, page: { width: number; height: number }, margin: number, body: number): Page[] {
  const pages: Page[] = [];
  const line = tocLineHeight(body);
  const capacity = Math.max(1, Math.floor((page.height - margin * 2 - 52) / line));
  const rows = entries.length ? entries : [{ label: labels.contentsHeading, page: 1, indent: 0 }];
  for (let offset = 0; offset < rows.length; offset += capacity) {
    const slice = rows.slice(offset, offset + capacity);
    const commands: string[] = [];
    let y = page.height - margin - 8;
    y = orangeHeading(commands, margin, y, page.width - margin * 2, labels.contentsHeading, 16);
    y -= 8;
    for (const item of slice) {
      const x = margin + item.indent * 16;
      const pageLabel = String(item.page);
      const pageWidth = textWidth(pageLabel, body);
      commands.push(textOp(x, y, body, item.label, INK));
      commands.push(textOp(page.width - margin - pageWidth, y, body, pageLabel, INK));
      const dotsFrom = x + textWidth(item.label, body) + 4;
      const dotsTo = page.width - margin - pageWidth - 4;
      for (let dot = dotsFrom; dot < dotsTo; dot += 3.2) commands.push(fill(dot, y + 1, 0.7, 0.7, "0.55 0.55 0.55"));
      y -= line;
    }
    pages.push({ commands });
  }
  return pages;
}

function orangeHeading(commands: string[], x: number, y: number, width: number, text: string, size: number): number {
  commands.push(textOp(x, y, size, text, ORANGE));
  const textW = Math.min(textWidth(text, size), width - 24);
  const lineY = y + size * 0.35;
  commands.push(`${ORANGE} RG 1.4 w ${num(x + textW + 8)} ${num(lineY)} m ${num(x + width - 6)} ${num(lineY)} l S`);
  commands.push(`${ORANGE} rg ${num(x + width - 3.5)} ${num(lineY)} 3.2 0 360 arc f`);
  return y - size - 8;
}

function flowLines(lines: string[], page: { width: number; height: number }, margin: number, body: number, heading = ""): Page[] {
  const pages: Page[] = [];
  let commands: string[] = [];
  let y = page.height - margin - body - 8;
  const start = () => {
    commands = [];
    y = page.height - margin - 8;
    if (heading) y = orangeHeading(commands, margin, y, page.width - margin * 2, heading, body + 5) - 6;
  };
  const push = () => {
    if (commands.length) pages.push({ commands });
    start();
  };
  start();
  for (const paragraph of lines) {
    for (const line of wrap(paragraph, body, page.width - margin * 2)) {
      if (y < margin + body) push();
      commands.push(textOp(margin, y, body, line, INK));
      y -= body + 5;
    }
    y -= 8;
  }
  if (commands.length) pages.push({ commands });
  return pages;
}

function flowObjects(tables: DictionaryTable[], labels: DataDictionaryLabels, layout: DictionaryLayout, page: { width: number; height: number }, margin: number): { pages: Page[]; placed: PlacedObject[] } {
  const pages: Page[] = [];
  const placed: PlacedObject[] = [];
  const cursor = { commands: [] as string[], y: 0, bookmark: undefined as string | undefined };
  const bottom = contentBottom(margin);
  const top = () => page.height - margin - (layout.includeBreadcrumbs ? 22 : 6);
  const flush = () => {
    if (cursor.commands.length === 0 && !cursor.bookmark) return;
    pages.push({ commands: cursor.commands, bookmark: cursor.bookmark });
    cursor.commands = [];
    cursor.bookmark = undefined;
    cursor.y = top();
  };
  const nextPage = () => flush();
  const ensure = (height: number) => {
    if (cursor.y - height < bottom) nextPage();
  };
  cursor.y = top();
  if (tables.length === 0) return { pages: [{ commands: [] }], placed };
  for (const table of tables) {
    const title = `${kindLabel(table, labels)}: ${table.name}`;
    ensure(layout.headingSize + 20);
    if (!cursor.bookmark) cursor.bookmark = qualifiedObjectName(table);
    placed.push({ table, page: pages.length });
    cursor.y = orangeHeading(cursor.commands, margin, cursor.y, page.width - margin * 2, title, layout.headingSize);
    cursor.y -= 6;
    if (table.note) {
      for (const line of wrap(table.note, layout.bodySize, page.width - margin * 2)) {
        cursor.commands.push(textOp(margin, cursor.y, layout.bodySize, line, MUTED));
        cursor.y -= layout.bodySize + 4;
      }
      cursor.y -= 8;
    }
    cursor.commands.push(textOp(margin, cursor.y, layout.bodySize, labels.column, INK));
    cursor.y -= layout.bodySize + 6;
    cursor.y = drawTable(cursor, columnRows(table, labels), margin, page.width - margin * 2, layout.bodySize, bottom, nextPage, ensure, [0.55, 1.6, 1.3, 0.9, 1.8]);
    if (layout.includeIndexesAndForeignKeys && table.indexes.length > 0) {
      cursor.y = quietLabel(cursor, labels.indexesHeading, margin, layout.bodySize, ensure);
      cursor.y = drawTable(cursor, indexRows(table, labels), margin, page.width - margin * 2, layout.bodySize, bottom, nextPage, ensure, [1.8, 1.3, 0.7, 0.7, 0.9, 1.6]);
    }
    if (layout.includeIndexesAndForeignKeys && table.foreignKeys.length > 0) {
      cursor.y = quietLabel(cursor, labels.foreignKeysHeading, margin, layout.bodySize, ensure);
      cursor.y = drawTable(cursor, foreignKeyRows(table, labels), margin, page.width - margin * 2, layout.bodySize, bottom, nextPage, ensure, [1.7, 1.2, 1.1, 1.2, 1, 0.9, 1]);
    }
    cursor.y -= 16;
  }
  flush();
  return { pages, placed };
}

function quietLabel(cursor: { commands: string[]; y: number }, title: string, x: number, size: number, ensure: (height: number) => void): number {
  ensure(size + 28);
  const y = cursor.y - 20;
  cursor.commands.push(fill(x, y - 1, 18, 2, ORANGE));
  cursor.commands.push(textOp(x + 24, y - size * 0.2, size, title, ORANGE));
  return y - size - 8;
}

function kindLabel(table: DictionaryTable, labels: DataDictionaryLabels): string {
  if (table.kind === "VIEW") return labels.kindView;
  if (table.kind === "MATERIALIZED_VIEW") return labels.kindMaterializedView;
  return labels.kindTable;
}

function columnRows(table: DictionaryTable, labels: DataDictionaryLabels): string[][] {
  return [
    ["#", labels.column, labels.type, labels.nullable, labels.extra],
    ...table.columns.map((column, index) => [String(index + 1), column.name, typeLabel(column), column.is_nullable ? "" : CHECK, [column.extra, columnComment(table, column)].filter((part) => part && part.trim() !== "").join(" ")]),
  ];
}

function indexRows(table: DictionaryTable, labels: DataDictionaryLabels): string[][] {
  return [
    [labels.indexName, labels.indexColumns, labels.unique, labels.primaryKey, labels.indexType, labels.comment],
    ...table.indexes.map((index) => [index.name, index.columns.join(", "), yesNo(index.is_unique, labels), yesNo(index.is_primary, labels), index.index_type ?? "", index.comment ?? ""]),
  ];
}

function foreignKeyRows(table: DictionaryTable, labels: DataDictionaryLabels): string[][] {
  return [[labels.constraintName, labels.column, labels.refSchema, labels.refTable, labels.refColumn, labels.onUpdate, labels.onDelete], ...table.foreignKeys.map((key) => [key.name, key.column, key.ref_schema ?? "", key.ref_table, key.ref_column, key.on_update ?? "", key.on_delete ?? ""])];
}

function yesNo(value: boolean, labels: DataDictionaryLabels): string {
  return value ? labels.yes : labels.no;
}

function drawTable(cursor: { commands: string[]; y: number }, rows: string[][], x: number, width: number, size: number, bottom: number, nextPage: () => void, ensure: (height: number) => void, weights?: number[]): number {
  if (rows.length === 0 || !rows[0]) return cursor.y;
  const header = rows[0];
  const used = weights && weights.length === header.length ? weights : header.map((_, index) => (index === header.length - 1 ? 2.2 : 1));
  const weightSum = used.reduce((sum, weight) => sum + weight, 0);
  const widths = used.map((weight) => (width * weight) / weightSum);
  const rowHeight = (row: string[]) => {
    const wrapped = row.map((cell, index) => wrap(cell, size, Math.max(8, widths[index]! - 8)));
    return { wrapped, height: Math.max(1, ...wrapped.map((item) => item.length)) * (size + 3) + 8 };
  };
  const paint = (row: string[], headerRow: boolean, zebra: boolean) => {
    const painted = rowHeight(row);
    ensure(painted.height);
    const top = cursor.y;
    const boxY = top - painted.height;
    if (headerRow) cursor.commands.push(fill(x, boxY, width, painted.height, PEACH));
    else if (zebra) cursor.commands.push(fill(x, boxY, width, painted.height, "0.995 0.98 0.96"));
    cursor.commands.push(`${GRID} RG 0.7 w ${num(x)} ${num(boxY)} ${num(width)} ${num(painted.height)} re S`);
    let columnX = x;
    const linePitch = size + 3;
    const block = painted.wrapped.reduce((max, cell) => Math.max(max, cell.length), 1) * linePitch - 3;
    const firstBaseline = boxY + (painted.height - block) / 2 + size * 0.78;
    painted.wrapped.forEach((cell, index) => {
      if (index > 0) cursor.commands.push(`${GRID} RG 0.5 w ${num(columnX)} ${num(boxY)} m ${num(columnX)} ${num(boxY + painted.height)} l S`);
      if (cell.length === 1 && cell[0] === CHECK) {
        const markX = columnX + widths[index]! / 2;
        const markY = boxY + painted.height / 2;
        cursor.commands.push(`${INK} RG 1.15 w ${num(markX - 3.4)} ${num(markY - 0.4)} m ${num(markX - 0.8)} ${num(markY - 3.2)} l ${num(markX + 4.2)} ${num(markY + 3.2)} l S`);
      } else {
        cell.forEach((line, lineIndex) => {
          const lineWidth = textWidth(line, size);
          const textX = columnX + Math.max(3, (widths[index]! - lineWidth) / 2);
          cursor.commands.push(textOp(textX, firstBaseline - lineIndex * linePitch, size, line, INK));
        });
      }
      columnX += widths[index]!;
    });
    cursor.y -= painted.height;
  };
  paint(header, true, false);
  rows.slice(1).forEach((row, index) => {
    if (cursor.y - rowHeight(row).height < bottom) {
      nextPage();
      paint(header, true, false);
    }
    paint(row, false, index % 2 === 1);
  });
  return cursor.y;
}

function contentBottom(margin: number): number {
  return Math.max(margin, 36);
}

function stampChrome(pages: Page[], layout: DictionaryLayout, page: { width: number; height: number }, margin: number, frontCount: number): void {
  pages.forEach((item, index) => {
    if (index < frontCount) return;
    if (layout.includeBreadcrumbs && layout.header) item.commands.unshift(textOp(margin, page.height - margin + 6, Math.max(8, layout.bodySize - 1), layout.header, MUTED));
    const footerY = 22;
    if (layout.includeLeftFooter && layout.leftFooter) item.commands.push(textOp(margin, footerY, layout.bodySize, layout.leftFooter, MUTED));
    else if (layout.title) item.commands.push(textOp(margin, footerY, layout.bodySize, layout.title, MUTED));
    if (layout.includePageNumber) {
      const label = String(index - frontCount + 1);
      item.commands.push(textOp(page.width - margin - textWidth(label, layout.bodySize), footerY, layout.bodySize, label, MUTED));
    }
  });
}

function textOp(x: number, y: number, size: number, text: string, color = INK): string {
  const parts = ["BT"];
  let cursor = x;
  let run = "";
  let runAscii = false;
  const flush = () => {
    if (!run) return;
    if (runAscii) parts.push(`${color} rg /F2 ${num(size)} Tf 1 0 0 1 ${num(cursor - textWidth(run, size))} ${num(y)} Tm (${escapePdf(run)}) Tj`);
    else parts.push(`${color} rg /F1 ${num(size)} Tf 1 0 0 1 ${num(cursor - textWidth(run, size))} ${num(y)} Tm <${pdfUtf16Hex(run)}> Tj`);
    run = "";
  };
  for (const char of text) {
    const ascii = (char.codePointAt(0) ?? 0) < 128;
    if (run && ascii !== runAscii) flush();
    runAscii = ascii;
    run += char;
    cursor += charWidth(char, size);
  }
  flush();
  parts.push("ET");
  return parts.join(" ");
}

function escapePdf(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function num(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function encodePdf(pages: Page[], size: { width: number; height: number }, title: string): Uint8Array {
  const objects: string[] = [];
  const pageIds: number[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UTF16-H /DescendantFonts [5 0 R] >>";
  objects[5] = "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 /FontDescriptor 6 0 R >>";
  objects[6] = "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 620 /StemV 80 >>";
  objects[7] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let nextId = 8;
  for (const page of pages) {
    const contentId = nextId++;
    const pageId = nextId++;
    pageIds.push(pageId);
    const stream = page.commands.join("\n");
    objects[contentId] = `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(size.width)} ${num(size.height)}] /Resources << /Font << /F1 3 0 R /F2 7 0 R >> >> /Contents ${contentId} 0 R >>`;
  }
  objects[2] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  const bookmarks = pages.flatMap((page, index) => (page.bookmark ? [{ pageId: pageIds[index]!, title: page.bookmark }] : []));
  if (bookmarks.length === 0) {
    objects[4] = "<< /Type /Outlines /Count 0 >>";
  } else {
    const first = nextId;
    bookmarks.forEach((item, index) => {
      const id = nextId++;
      const prev = index === 0 ? "" : ` /Prev ${id - 1} 0 R`;
      const next = index === bookmarks.length - 1 ? "" : ` /Next ${id + 1} 0 R`;
      objects[id] = `<< /Title <FEFF${pdfUtf16Hex(item.title)}> /Parent 4 0 R${prev}${next} /Dest [${item.pageId} 0 R /Fit] >>`;
    });
    objects[4] = `<< /Type /Outlines /First ${first} 0 R /Last ${nextId - 1} 0 R /Count ${bookmarks.length} >>`;
  }
  const infoId = nextId;
  objects[infoId] = `<< /Title <FEFF${pdfUtf16Hex(title)}> >>`;
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /Info ${infoId} 0 R >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id <= infoId; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id] ?? "<<>>"}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${infoId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= infoId; id++) pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${infoId + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
