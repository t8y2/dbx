import { describe, expect, it } from "vitest";
import { IMPORT_SKIP_TARGET } from "@/lib/table/tableImport";
import { IMPORT_MAPPING_TEMPLATES_STORAGE_KEY, applyImportMappingTemplate, readImportMappingTemplates, withImportMappingTemplate, withoutImportMappingTemplate, writeImportMappingTemplates } from "@/lib/table/importMappingTemplates";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[IMPORT_MAPPING_TEMPLATES_STORAGE_KEY, initial]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
}

describe("importMappingTemplates", () => {
  it("round-trips templates through storage", () => {
    const storage = memoryStorage();
    const templates = withImportMappingTemplate([], "Customers", { Name: "customer_name", Email: "email" });
    writeImportMappingTemplates(templates, storage);

    expect(readImportMappingTemplates(storage)).toEqual([{ name: "Customers", mapping: { Name: "customer_name", Email: "email" } }]);
  });

  it("ignores malformed storage and drops entries without a name or a mapped column", () => {
    expect(readImportMappingTemplates(memoryStorage("not json"))).toEqual([]);
    expect(readImportMappingTemplates(memoryStorage('{"name":"x"}'))).toEqual([]);
    expect(
      readImportMappingTemplates(
        memoryStorage(
          JSON.stringify([
            { name: " ", mapping: { a: "b" } },
            { name: "empty", mapping: { a: "" } },
            { name: "ok", mapping: { a: "b", c: 3 } },
            { name: "OK", mapping: { a: "z" } },
          ]),
        ),
      ),
    ).toEqual([{ name: "ok", mapping: { a: "b" } }]);
  });

  it("replaces a template with the same name regardless of case and leaves the list alone for empty input", () => {
    const first = withImportMappingTemplate([], "Orders", { a: "x" });
    const replaced = withImportMappingTemplate(first, " orders ", { b: "y", skipped: "" });

    expect(replaced).toEqual([{ name: "orders", mapping: { b: "y" } }]);
    expect(withImportMappingTemplate(first, "", { a: "x" })).toBe(first);
    expect(withImportMappingTemplate(first, "Nothing", { a: "" })).toBe(first);
  });

  it("deletes by name", () => {
    const templates = withImportMappingTemplate(withImportMappingTemplate([], "A", { a: "x" }), "B", { b: "y" });

    expect(withoutImportMappingTemplate(templates, "a").map((template) => template.name)).toEqual(["B"]);
  });

  it("maps matching source columns to existing table columns and skips the rest", () => {
    const template = { name: "T", mapping: { "Customer Name": "customer_name", Email: "email", Legacy: "old_column" } };
    const result = applyImportMappingTemplate(template, ["customer_name", "EMAIL", "Notes", "Legacy"], ["id", "Customer_Name", "email"]);

    expect(result.mapping).toEqual({ customer_name: "Customer_Name", EMAIL: "email", Notes: "", Legacy: "" });
    expect(result.matched).toBe(2);
  });

  it("does not map two file columns into the same table column", () => {
    const template = { name: "T", mapping: { a: "x", b: "x" } };
    const result = applyImportMappingTemplate(template, ["a", "b"], ["x"]);

    expect(result.mapping).toEqual({ a: "x", b: "" });
    expect(result.matched).toBe(1);
  });
});

it("skips source columns without an own mapping even when their names are object methods", () => {
  const result = applyImportMappingTemplate({ name: "Saved", mapping: { id: "id" } }, ["constructor", "id"], ["id"]);
  expect(result.mapping["constructor"]).toBe(IMPORT_SKIP_TARGET);
  expect(result.matched).toBe(1);
});
