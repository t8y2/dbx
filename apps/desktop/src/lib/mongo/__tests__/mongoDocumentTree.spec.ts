import { describe, expect, it } from "vitest";
import {
  buildMongoFlatColumns,
  buildMongoTreeRows,
  collectMongoTreeContainerIds,
  getMongoPathValue,
  hasNestedMongoColumns,
  isMongoSubdocument,
  listExpandableMongoColumns,
  mongoTreeRowId,
  mongoValueDisplay,
  mongoValuePreviewText,
  mongoValueTypeLabel,
  projectMongoDocument,
} from "../mongoDocumentTree";

const docs = [
  {
    _id: { $oid: "65f0c0ffee0000000000aaaa" },
    name: "Ann",
    address: { city: "Bangkok", geo: { lat: 13.7, lng: 100.5 } },
    tags: ["a", "b"],
    createdAt: { $date: "2026-11-24T02:00:00Z" },
  },
  {
    _id: { $oid: "65f0c0ffee0000000000bbbb" },
    name: "Bo",
    address: "unknown",
    profile: { age: { $numberInt: "31" } },
  },
];

describe("mongo value helpers", () => {
  it("treats extended JSON wrappers as scalars, not subdocuments", () => {
    expect(isMongoSubdocument({ $oid: "65f0c0ffee0000000000aaaa" })).toBe(false);
    expect(isMongoSubdocument({ $date: "2026-01-01T00:00:00Z" })).toBe(false);
    expect(isMongoSubdocument({ city: "x" })).toBe(true);
    expect(isMongoSubdocument([1])).toBe(false);
  });

  it("labels BSON types like NoSQLBooster", () => {
    expect(mongoValueTypeLabel({ $oid: "65f0c0ffee0000000000aaaa" })).toBe("ObjectId");
    expect(mongoValueTypeLabel({ $date: "2026-01-01T00:00:00Z" })).toBe("Date");
    expect(mongoValueTypeLabel({ $numberLong: "1" })).toBe("Int64");
    expect(mongoValueTypeLabel('ISODate("2026-01-01T00:00:00Z")')).toBe("Date");
    expect(mongoValueTypeLabel("hello")).toBe("String");
    expect(mongoValueTypeLabel(1)).toBe("Int32");
    expect(mongoValueTypeLabel(1.5)).toBe("Double");
    expect(mongoValueTypeLabel(null)).toBe("Null");
    expect(mongoValueTypeLabel([])).toBe("Array");
    expect(mongoValueTypeLabel({ a: 1 })).toBe("Object");
    expect(mongoValueTypeLabel({ $binary: { base64: "AA==", subType: "04" } })).toBe("UUID");
  });

  it("previews containers by size and scalars as mongosh text", () => {
    expect(mongoValuePreviewText({ a: 1, b: 2 })).toBe("{ 2 fields }");
    expect(mongoValuePreviewText([1])).toBe("[ 1 element ]");
    expect(mongoValuePreviewText({ $oid: "65f0c0ffee0000000000aaaa" })).toBe('ObjectId("65f0c0ffee0000000000aaaa")');
    expect(mongoValuePreviewText("plain")).toBe("plain");
    expect(mongoValuePreviewText({ $numberInt: "34" })).toBe("34");
    expect(mongoValuePreviewText({ $numberLong: "9007199254740993" })).toBe("9007199254740993");
    expect(mongoValuePreviewText({ $numberDecimal: "1520.75" })).toBe("1520.75");
    expect(mongoValuePreviewText({ $date: "2026-11-24T02:00:00Z" })).toBe('ISODate("2026-11-24T02:00:00Z")');
    expect(mongoValuePreviewText({ $timestamp: { t: 5, i: 1 } })).toBe("Timestamp(5, 1)");
    // Query results carry canonical dates as milliseconds.
    expect(mongoValuePreviewText({ $date: { $numberLong: "1628221714602" } })).toBe('ISODate("2021-08-06T03:48:34.602Z")');
    expect(mongoValuePreviewText({ $date: { $numberLong: "99999999999999999" } })).toBe("Date(99999999999999999)");
  });

  it("reads nested paths and stops at scalars", () => {
    expect(getMongoPathValue(docs[0], ["address", "geo", "lat"])).toBe(13.7);
    expect(getMongoPathValue(docs[0], ["tags", 1])).toBe("b");
    expect(getMongoPathValue(docs[1], ["address", "city"])).toBeUndefined();
    expect(getMongoPathValue(docs[0], ["_id", "$oid"])).toBeUndefined();
  });
});

describe("buildMongoFlatColumns", () => {
  const base = ["_id", "name", "address", "tags", "createdAt", "profile"];

  it("keeps the top-level layout when nothing is expanded", () => {
    const columns = buildMongoFlatColumns(docs, base);
    expect(columns.map((column) => column.name)).toEqual(base);
    expect(hasNestedMongoColumns(columns)).toBe(false);
  });

  it("replaces an expanded column by its children and keeps the parent for mixed values", () => {
    const columns = buildMongoFlatColumns(docs, base, { expanded: ["address"] });
    // docs[1].address is a string, so the parent column stays to show it.
    expect(columns.map((column) => column.name)).toEqual(["_id", "name", "address", "address.city", "address.geo", "tags", "createdAt", "profile"]);
  });

  it("expands nested levels only when asked", () => {
    const columns = buildMongoFlatColumns(docs, base, { expanded: ["address", "address.geo"] });
    expect(columns.map((column) => column.name)).toContain("address.geo.lat");
    expect(columns.map((column) => column.name)).not.toContain("address.geo");
  });

  it("flattens every subdocument but never _id, arrays or BSON wrappers", () => {
    const names = buildMongoFlatColumns(docs, base, { flattenAll: true }).map((column) => column.name);
    expect(names).toEqual(["_id", "name", "address", "address.city", "address.geo.lat", "address.geo.lng", "tags", "createdAt", "profile.age"]);
  });

  it("respects the depth limit", () => {
    const names = buildMongoFlatColumns(docs, base, { flattenAll: true, maxDepth: 1 }).map((column) => column.name);
    expect(names).toContain("address.geo");
    expect(names).not.toContain("address.geo.lat");
  });

  it("caps the number of produced columns", () => {
    const wide = [{ _id: 1, wide: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`k${index}`, index])) }];
    const columns = buildMongoFlatColumns(wide, ["_id", "wide"], { flattenAll: true, maxColumns: 10 });
    expect(columns.length).toBeLessThanOrEqual(10);
  });

  it("keeps a literal dotted key distinct from a nested path", () => {
    const dotted = [{ _id: 1, "a.b": "literal", a: { b: "nested" } }];
    const columns = buildMongoFlatColumns(dotted, ["_id", "a.b", "a"], { expanded: ["a"] });
    expect(new Set(columns.map((column) => column.name)).size).toBe(columns.length);
    const projected = projectMongoDocument(dotted[0], columns);
    expect(Object.values(projected)).toEqual(expect.arrayContaining(["literal", "nested"]));
  });

  it("lists only columns that hold subdocuments", () => {
    const columns = buildMongoFlatColumns(docs, base);
    expect(listExpandableMongoColumns(docs, columns)).toEqual(["address", "profile"]);
  });

  it("projects documents onto flat columns, leaving missing fields undefined", () => {
    const columns = buildMongoFlatColumns(docs, base, { flattenAll: true });
    const projected = projectMongoDocument(docs[1], columns);
    expect(projected["address"]).toBe("unknown");
    expect(projected["profile.age"]).toEqual({ $numberInt: "31" });
    expect("address.city" in projected).toBe(false);
  });
});

describe("buildMongoTreeRows", () => {
  it("shows one collapsed root row per document", () => {
    const rows = buildMongoTreeRows(docs, { expanded: new Set() });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ depth: 0, type: "Document", valueText: "{ 5 fields }", expandable: true, expanded: false });
    expect(rows[0]?.key).toBe("(01) 65f0c0ffee0000000000aaaa");
  });

  it("numbers roots from the page offset", () => {
    const rows = buildMongoTreeRows(docs, { expanded: new Set(), indexOffset: 50 });
    expect(rows[1]?.key.startsWith("(52)")).toBe(true);
    expect(rows[0]?.key.startsWith("(51)")).toBe(true);
  });

  it("expands documents, subdocuments and arrays in place", () => {
    const expanded = new Set([mongoTreeRowId(0, []), mongoTreeRowId(0, ["address"]), mongoTreeRowId(0, ["tags"])]);
    const rows = buildMongoTreeRows(docs, { expanded });
    expect(rows.map((row) => `${"  ".repeat(row.depth)}${row.key}:${row.type}`)).toEqual([
      "(01) 65f0c0ffee0000000000aaaa:Document",
      "  _id:ObjectId",
      "  name:String",
      "  address:Object",
      "    city:String",
      "    geo:Object",
      "  tags:Array",
      "    [0]:String",
      "    [1]:String",
      "  createdAt:Date",
      "(02) 65f0c0ffee0000000000bbbb:Document",
    ]);
  });

  it("truncates huge containers with a summary row", () => {
    const big = [{ _id: 1, list: Array.from({ length: 30 }, (_, index) => index) }];
    const rows = buildMongoTreeRows(big, { expanded: new Set([mongoTreeRowId(0, []), mongoTreeRowId(0, ["list"])]), maxChildren: 10 });
    expect(rows.at(-1)).toMatchObject({ key: "…", valueText: "+20" });
  });

  it("collects container ids for expand all", () => {
    const ids = collectMongoTreeContainerIds(docs);
    expect(ids).toContain(mongoTreeRowId(0, ["address", "geo"]));
    expect(ids).toContain(mongoTreeRowId(1, ["profile"]));
    expect(ids).not.toContain(mongoTreeRowId(0, ["_id"]));
  });
});

describe("flattenMongoQueryResult", () => {
  it("re-projects a query result onto dot-path columns and keeps the documents", async () => {
    const { flattenMongoQueryResult, mongoDocumentsToQueryResult } = await import("../mongoShellCommand");
    const result = mongoDocumentsToQueryResult(docs, 1, docs.length, docs);
    const columns = buildMongoFlatColumns(docs, result.columns, { expanded: ["address"] });
    const flat = flattenMongoQueryResult({ ...result, local_column_filters: { "0": ["x"] }, appended_from_row_count: 1 }, columns);
    expect(flat.columns).toEqual(["_id", "name", "address", "address.city", "address.geo", "tags", "createdAt", "profile"]);
    expect(flat.rows[0]?.[3]).toBe("Bangkok");
    expect(flat.rows[1]?.[3]).toBeNull();
    expect(flat.rows[1]?.[2]).toBe("unknown");
    expect(flat.mongo_documents).toBe(result.mongo_documents);
    // Index-keyed view state from the original layout must not leak onto new columns.
    expect(flat.local_column_filters).toBeUndefined();
    expect(flat.appended_from_row_count).toBeUndefined();
    expect(flat.column_types?.[6]).toBe("datetime");
  });
});

describe("mongoValueDisplay (NoSQLBooster style)", () => {
  const now = Date.parse("2026-11-24T04:58:08.361Z");
  const options = { locale: "en-US", now };

  it("shows dates in local time with a relative age and a UTC/ISO tooltip", () => {
    const display = mongoValueDisplay({ $date: { $numberLong: String(Date.parse("2026-11-24T04:36:08.361Z")) } }, options);
    expect(display.text).toMatch(/^11\/24\/2026, \d{2}:36:08 (AM|PM) - 22 minutes ago$/);
    expect(display.tooltip).toContain("UTC: 2026-11-24T04:36:08.361Z");
    expect(display.tooltip).toMatch(/ISO: 2026-11-24T\d{2}:36:08\.361[+-]\d{2}:\d{2}/);
  });

  it("keeps the Gregorian year for Thai", () => {
    const display = mongoValueDisplay({ $date: "2026-11-24T04:36:08Z" }, { locale: "th-TH", now });
    expect(display.text).toContain("2026");
    expect(display.text).not.toContain("2569");
  });

  it("shows ObjectIds as hex with their creation age", () => {
    const hex = Math.floor(Date.parse("2026-11-24T04:36:08Z") / 1000).toString(16) + "0000000000000000";
    const display = mongoValueDisplay({ $oid: hex }, options);
    expect(display.text).toBe(hex);
    expect(display.hint).toBe("22 minutes ago");
  });

  it("previews documents and arrays inline with counts", () => {
    expect(mongoValueDisplay({ _id: { $oid: "65f0c0ffee0000000000aaaa" }, user_type: "Customer", referral: 0, mobile: "0994", deep: { a: 1 } }, options).text).toBe('{ user_type : "Customer", referral : 0, mobile : "0994", … } (5 fields)');
    expect(mongoValueDisplay([1795494968], options).text).toBe("[ 1795494968 ] (1 element)");
    expect(mongoValueDisplay([1, 2, 3, 4], options).text).toBe("[ 1, 2, 3, … ] (4 elements)");
  });
});

describe("tree actions", () => {
  it("builds filters with readable BSON values and multikey paths", async () => {
    const { buildMongoValueFilter, mergeMongoFilterText } = await import("../mongoDocumentTree");
    const doc = { _id: { $oid: "65f0c0ffee0000000000aaaa" }, age: { $numberInt: "31" }, at: { $date: { $numberLong: "1628221714602" } }, orders: [{ sku: "A-1" }] };
    expect(buildMongoValueFilter(doc, [])).toEqual({ _id: { $oid: "65f0c0ffee0000000000aaaa" } });
    expect(buildMongoValueFilter(doc, ["age"])).toEqual({ age: 31 });
    expect(buildMongoValueFilter(doc, ["at"])).toEqual({ at: { $date: "2021-08-06T03:48:34.602Z" } });
    expect(buildMongoValueFilter(doc, ["orders", 0, "sku"])).toEqual({ "orders.sku": "A-1" });
    expect(mergeMongoFilterText('{"status":true}', { age: 31 })).toBe('{"status":true,"age":31}');
    expect(mergeMongoFilterText("{status: true}", { age: 31 })).toBe('{"age":31}');
    expect(mergeMongoFilterText("", { age: 31 })).toBe('{"age":31}');
  });

  it("labels indexed fields like NoSQLBooster", async () => {
    const { buildMongoIndexLabels } = await import("../mongoDocumentTree");
    const labels = buildMongoIndexLabels([
      { keys: [{ field: "_id", direction: "1" }] },
      { keys: [{ field: "mobile_number", direction: "1" }], is_unique: true },
      { keys: [{ field: "created_at", direction: "-1" }] },
      {
        keys: [
          { field: "user_type", direction: "1" },
          { field: "status", direction: "1" },
        ],
      },
      {
        keys: [
          { field: "_fts", direction: "text" },
          { field: "_ftsx", direction: "1" },
        ],
      },
    ]);
    expect(labels.get("_id")).toBe("asc index");
    expect(labels.get("mobile_number")).toBe("unique asc index");
    expect(labels.get("created_at")).toBe("desc index");
    expect(labels.get("user_type")).toBe("asc index");
    expect(labels.get("status")).toBe("compound index");
    expect(labels.has("_fts")).toBe(false);
  });

  it("parses inline edits without changing the field's BSON type", async () => {
    const { parseMongoTreeEditValue } = await import("../mongoDocumentValues");
    expect(parseMongoTreeEditValue("42", { $numberInt: "1" })).toEqual({ ok: true, value: { $numberInt: "42" } });
    expect(parseMongoTreeEditValue("42", { $numberLong: "1" })).toEqual({ ok: true, value: { $numberLong: "42" } });
    expect(parseMongoTreeEditValue("42", "old")).toEqual({ ok: true, value: "42" });
    expect(parseMongoTreeEditValue("false", true)).toEqual({ ok: true, value: false });
    expect(parseMongoTreeEditValue("maybe", true)).toEqual({ ok: false });
    expect(parseMongoTreeEditValue("2026-11-24T04:36:08.361Z", { $date: { $numberLong: "0" } })).toEqual({ ok: true, value: { $date: "2026-11-24T04:36:08.361Z" } });
    expect(parseMongoTreeEditValue("not a date", { $date: { $numberLong: "0" } })).toEqual({ ok: false });
    expect(parseMongoTreeEditValue("65F0C0FFEE0000000000AAAA", { $oid: "65f0c0ffee0000000000bbbb" })).toEqual({ ok: true, value: { $oid: "65f0c0ffee0000000000aaaa" } });
  });

  it("decides which rows are editable inline", async () => {
    const { isMongoTreeEditable } = await import("../mongoDocumentTree");
    expect(isMongoTreeEditable({ path: ["name"], expandable: false, value: "x", key: "name" })).toBe(true);
    expect(isMongoTreeEditable({ path: ["_id"], expandable: false, value: { $oid: "65f0c0ffee0000000000aaaa" }, key: "_id" })).toBe(false);
    expect(isMongoTreeEditable({ path: [], expandable: true, value: {}, key: "(01)" })).toBe(false);
    expect(isMongoTreeEditable({ path: ["address"], expandable: true, value: { city: "x" }, key: "address" })).toBe(false);
    expect(isMongoTreeEditable({ path: ["blob"], expandable: false, value: { $binary: { base64: "AA==", subType: "00" } }, key: "blob" })).toBe(false);
  });

  it("sets nested values immutably and converts canonical values for browser rows", async () => {
    const { setMongoPathValue, mongoCanonicalToBrowserValue } = await import("../mongoDocumentTree");
    const original = { a: { b: [{ c: 1 }] } };
    const next = setMongoPathValue(original, ["a", "b", 0, "c"], 2);
    expect(next).toEqual({ a: { b: [{ c: 2 }] } });
    expect(original.a.b[0]?.c).toBe(1);
    expect(mongoCanonicalToBrowserValue({ $numberInt: "5" })).toBe(5);
    expect(mongoCanonicalToBrowserValue({ $date: "2026-11-24T04:36:08.361Z" })).toBe('ISODate("2026-11-24T04:36:08.361Z")');
    expect(mongoCanonicalToBrowserValue({ $oid: "65f0c0ffee0000000000aaaa" })).toEqual({ $oid: "65f0c0ffee0000000000aaaa" });
  });
});
