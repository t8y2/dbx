import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "@/docs/types";
import { applyTemplate, dataDictionaryFileName, dictionaryCatalogNames, exportBlockedBySkippedTables, moveOrderedKey, objectKey, orderDictionaryTables, resolveDictionaryExportPath, toggleOrderedKey, warningsForSelection, type DictionaryLayout, type DictionaryTable } from "@/lib/docs/dataDictionary";
import { buildDataDictionaryPdf, pdfUtf16Hex } from "@/lib/docs/dataDictionaryPdf";

const labels = {
  column: "Column",
  type: "Type",
  length: "Length",
  precision: "Precision",
  scale: "Scale",
  primaryKey: "Primary key",
  nullable: "Nullable",
  unique: "Unique",
  defaultValue: "Default",
  extra: "Extra",
  comment: "Comment",
  indexName: "Index",
  indexColumns: "Index columns",
  indexType: "Index type",
  constraintName: "Constraint",
  refSchema: "Referenced schema",
  refTable: "Referenced table",
  refColumn: "Referenced column",
  onUpdate: "ON UPDATE",
  onDelete: "ON DELETE",
  yes: "Yes",
  no: "No",
  indexesHeading: "Indexes",
  foreignKeysHeading: "Foreign keys",
  contentsHeading: "Contents",
  kindTable: "Table",
  kindView: "View",
  kindMaterializedView: "Materialized view",
};

function column(partial: Partial<ColumnInfo> & Pick<ColumnInfo, "name" | "data_type">): ColumnInfo {
  return {
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    extra: null,
    comment: null,
    numeric_precision: null,
    numeric_scale: null,
    character_maximum_length: null,
    ...partial,
  };
}

function table(partial: Partial<DictionaryTable> & Pick<DictionaryTable, "name">): DictionaryTable {
  return {
    database: "shop",
    schema: "public",
    kind: "TABLE",
    columns: [column({ name: "id", data_type: "integer", is_primary_key: true, is_nullable: false })],
    indexes: [],
    foreignKeys: [],
    groupId: null,
    note: null,
    noteSource: "NONE",
    shadowedNote: null,
    columnNotes: {},
    estimatedRows: null,
    viewDefinition: null,
    ...partial,
  };
}

describe("dictionaryCatalogNames", () => {
  it("hides internal schemas unless that schema was explicitly opened", () => {
    const listed = ["shop", "information_schema", "performance_schema", "mysql", "sys", "public"];
    expect(dictionaryCatalogNames(listed, "mysql")).toEqual(["shop", "public"]);
    expect(dictionaryCatalogNames(listed, "mysql", "information_schema")).toEqual(["shop", "information_schema", "public"]);
    expect(dictionaryCatalogNames(["public", "pg_catalog", "information_schema"], "postgres")).toEqual(["public"]);
  });
});

describe("dictionary selection", () => {
  it("checks, unchecks, and reorders objects", () => {
    const orders = objectKey({ database: "shop", schema: "public", name: "orders" });
    const users = objectKey({ database: "shop", schema: "public", name: "users" });
    expect(toggleOrderedKey([], orders, true)).toEqual([orders]);
    expect(toggleOrderedKey([orders, users], orders, false)).toEqual([users]);
    expect(moveOrderedKey([orders, users], users, -1)).toEqual([users, orders]);
  });

  it("exports tables in the selected order", () => {
    const orders = table({ name: "orders" });
    const users = table({ name: "users" });
    const ordered = orderDictionaryTables([orders, users], [objectKey(users), objectKey(orders)]);
    expect(ordered.map((item) => item.name)).toEqual(["users", "orders"]);
  });
});

describe("dataDictionaryFileName", () => {
  it("appends a timestamp when requested, including on a path that was already chosen", () => {
    const now = new Date("2026-09-24T14:05:06");
    expect(dataDictionaryFileName("shop", false, now)).toBe("shop-data-dictionary.pdf");
    expect(dataDictionaryFileName("a/b", true, now)).toBe("a_b-data-dictionary_20260924140506.pdf");
    expect(resolveDictionaryExportPath("/tmp/shop.pdf", "shop-data-dictionary.pdf", true, now)).toBe("/tmp/shop_20260924140506.pdf");
    expect(resolveDictionaryExportPath("", "shop-data-dictionary.pdf", true, now)).toBe("shop-data-dictionary_20260924140506.pdf");
    expect(resolveDictionaryExportPath("/tmp/shop_20260924140506.pdf", "ignored.pdf", true, now)).toBe("/tmp/shop_20260924140506.pdf");
  });
});

describe("exportBlockedBySkippedTables", () => {
  it("stops export only when continue-on-error is off and a selected table was skipped", () => {
    const warnings = [{ kind: "tableSkipped", table: "secret", reason: "denied" }, { kind: "tableSkipped", table: "public.secret", reason: "denied" }, { kind: "commentsUnsupported" }];
    const selected = [{ schema: "public", name: "users" }];
    const relevant = warningsForSelection(warnings, selected);
    expect(exportBlockedBySkippedTables(relevant, false)).toBe(false);
    expect(exportBlockedBySkippedTables(relevant, true)).toBe(false);
    expect(relevant.some((warning) => warning.table?.includes("secret"))).toBe(false);
    expect(exportBlockedBySkippedTables(warningsForSelection([{ kind: "tableSkipped", table: "public.users", reason: "denied" }], selected), false)).toBe(true);
  });

  it("keeps the collector's empty-schema skip and drops schema-wide skips for other schemas", () => {
    const selected = [{ schema: "", name: "orders" }];
    const kept = warningsForSelection([{ kind: "tableSkipped", table: ".orders", reason: "denied" }], selected);
    const otherSchema = warningsForSelection([{ kind: "tableSkipped", table: "analytics.*", reason: "denied" }], selected);
    const ownSchema = warningsForSelection([{ kind: "tableSkipped", table: ".*", reason: "denied" }], selected);

    expect(exportBlockedBySkippedTables(kept, false)).toBe(true);
    expect(kept.map((warning) => warning.table)).toEqual([".orders"]);
    expect(exportBlockedBySkippedTables(otherSchema, false)).toBe(false);
    expect(otherSchema).toEqual([]);
    expect(ownSchema.map((warning) => warning.table)).toEqual([".*"]);
  });
});

describe("applyTemplate", () => {
  it("changes paper and sections with the template", () => {
    const standard = applyTemplate("standard", { title: "shop", introduction: "intro", detailedIntroduction: "detail", leftFooter: "shop" });
    const compact = applyTemplate("compact", { title: "shop", introduction: "intro", detailedIntroduction: "detail", leftFooter: "shop" });
    expect(standard.includeCover).toBe(true);
    expect(standard.includeIndexesAndForeignKeys).toBe(true);
    expect(compact.includeCover).toBe(false);
    expect(compact.includeIndexesAndForeignKeys).toBe(false);
    expect(compact.orientation).toBe("landscape");
  });
});

function pdfText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function textAt(pdf: string, text: string): number {
  const cjk = [...text].filter((char) => (char.codePointAt(0) ?? 0) >= 128).join("");
  if (cjk && [...text].every((char) => (char.codePointAt(0) ?? 0) >= 128)) return pdf.indexOf(pdfUtf16Hex(cjk));
  const literal = pdf.indexOf(`(${text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`);
  if (literal >= 0) return literal;
  const raw = pdf.indexOf(text);
  return raw >= 0 && pdf[raw - 1] !== "/" ? raw : -1;
}

describe("buildDataDictionaryPdf", () => {
  it("writes a PDF whose text includes only the chosen tables in order and omits indexes when that choice is off", () => {
    const users = table({ name: "users" });
    const orders = table({
      name: "orders",
      note: "订单",
      indexes: [{ name: "orders_pkey", columns: ["id"], is_unique: true, is_primary: true, filter: null, index_type: "btree", included_columns: null, comment: null }],
    });
    const guests = table({ name: "guests" });
    const chosen = orderDictionaryTables([users, orders, guests], [objectKey(orders), objectKey(users)]);
    const layout = applyTemplate("compact", { title: "shop", introduction: "intro", detailedIntroduction: "detail", leftFooter: "shop" });
    const pdf = pdfText(buildDataDictionaryPdf(chosen, labels, layout));

    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    const ordersAt = textAt(pdf, "orders");
    const usersAt = textAt(pdf, "users");
    expect(ordersAt).toBeGreaterThan(-1);
    expect(usersAt).toBeGreaterThan(ordersAt);
    expect(textAt(pdf, "订单")).toBeGreaterThan(-1);
    expect(textAt(pdf, "orders_pkey")).toBe(-1);
    expect(textAt(pdf, "guests")).toBe(-1);
  });

  it("changes the file when cover, contents, introduction, indexes, or paper changes", () => {
    const orders = table({
      name: "orders",
      indexes: [{ name: "orders_pkey", columns: ["id"], is_unique: true, is_primary: true, filter: null, index_type: "btree", included_columns: null, comment: null }],
    });
    const base: DictionaryLayout = {
      ...applyTemplate("standard", { title: "shop", introduction: "INTRO-ONLY-TEXT", detailedIntroduction: "detail", leftFooter: "shop" }),
      subtitle: "SUBTITLE-ONLY",
      includeIndexesAndForeignKeys: true,
    };
    const withChoices = pdfText(buildDataDictionaryPdf([orders], labels, base));
    const withoutCover = pdfText(buildDataDictionaryPdf([orders], labels, { ...base, includeCover: false }));
    const withoutContents = pdfText(buildDataDictionaryPdf([orders], labels, { ...base, includeToc: false }));
    const withoutIntro = pdfText(buildDataDictionaryPdf([orders], labels, { ...base, includeIntroduction: false }));
    const withoutIndexes = pdfText(buildDataDictionaryPdf([orders], labels, { ...base, includeIndexesAndForeignKeys: false }));
    const landscape = pdfText(buildDataDictionaryPdf([orders], labels, { ...base, orientation: "landscape" }));

    expect(textAt(withChoices, "SUBTITLE-ONLY")).toBeGreaterThan(-1);
    expect(textAt(withoutCover, "SUBTITLE-ONLY")).toBe(-1);
    expect(textAt(withChoices, labels.contentsHeading)).toBeGreaterThan(-1);
    expect(textAt(withoutContents, labels.contentsHeading)).toBe(-1);
    expect(textAt(withChoices, "INTRO-ONLY-TEXT")).toBeGreaterThan(-1);
    expect(textAt(withoutIntro, "INTRO-ONLY-TEXT")).toBe(-1);
    expect(textAt(withChoices, "orders_pkey")).toBeGreaterThan(-1);
    expect(textAt(withoutIndexes, "orders_pkey")).toBe(-1);
    expect(withChoices).toContain("/MediaBox [0 0 595.28 841.89]");
    expect(landscape).toContain("/MediaBox [0 0 841.89 595.28]");
  });

  it("numbers pages from the introduction so TOC entries match the printed footers", () => {
    const orders = table({ name: "orders" });
    const layout = applyTemplate("standard", {
      title: "shop",
      introduction: Array.from({ length: 160 }, (_, index) => `INTRO-LINE-${index}`).join("\n"),
      detailedIntroduction: "detail",
      leftFooter: "shop",
    });
    const streams = pdfText(buildDataDictionaryPdf([orders], labels, layout))
      .split("endstream")
      .filter((chunk) => chunk.includes("BT"));
    const introStreams = streams.filter((chunk) => chunk.includes("INTRO-LINE-"));
    expect(introStreams.length).toBeGreaterThanOrEqual(2);
    const lastIntroIndex = streams.lastIndexOf(introStreams[introStreams.length - 1]!);
    const bodyStream = streams.slice(lastIntroIndex + 1).find((chunk) => chunk.includes("orders"));
    expect(bodyStream).toBeDefined();
    const tocStream = streams.find((chunk) => chunk.includes("Contents"));
    expect(tocStream).toBeDefined();
    const introPages = introStreams.length;
    expect(introStreams[0]).toContain("(1) Tj");
    expect(introStreams[introPages - 1]).toContain(`(${introPages}) Tj`);
    expect(bodyStream).toContain(`(${introPages + 1}) Tj`);
    expect(tocStream).toContain(`(${introPages + 1}) Tj`);
  });

  it("does not abort or name an unselected skipped table when the snapshot warned about it", () => {
    const users = table({ name: "users", schema: "public" });
    const orders = table({ name: "orders", schema: "public" });
    const selected = orderDictionaryTables([users, orders], [objectKey(users)]);
    const warnings = warningsForSelection(
      [
        { kind: "tableSkipped", table: "secret", reason: "denied" },
        { kind: "tableSkipped", table: "public.secret", reason: "denied" },
      ],
      selected,
    );
    expect(exportBlockedBySkippedTables(warnings, false)).toBe(false);
    const pdf = pdfText(
      buildDataDictionaryPdf(
        selected,
        labels,
        applyTemplate("compact", { title: "shop", introduction: "intro", detailedIntroduction: "detail", leftFooter: "shop" }),
        warnings.map((warning) => `${warning.table}: ${warning.reason}`),
      ),
    );
    expect(textAt(pdf, "users")).toBeGreaterThan(-1);
    expect(textAt(pdf, "secret")).toBe(-1);
    expect(textAt(pdf, "orders")).toBe(-1);
  });

  it("names a selected empty-schema skip in the PDF and omits another schema's skip", () => {
    const orders = table({ name: "orders", schema: "" });
    const selected = [{ schema: "", name: "orders" }];
    const warnings = warningsForSelection(
      [
        { kind: "tableSkipped", table: ".orders", reason: "denied" },
        { kind: "tableSkipped", table: "analytics.*", reason: "denied" },
      ],
      selected,
    );
    const pdf = pdfText(
      buildDataDictionaryPdf(
        [orders],
        labels,
        applyTemplate("compact", { title: "shop", introduction: "intro", detailedIntroduction: "detail", leftFooter: "shop" }),
        warnings.map((warning) => `${warning.table}: ${warning.reason}`),
      ),
    );
    expect(textAt(pdf, ".orders")).toBeGreaterThan(-1);
    expect(textAt(pdf, "analytics.*")).toBe(-1);
  });
});
