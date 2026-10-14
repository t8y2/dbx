import { describe, expect, it } from "vitest";
import { convertToSchemaDiffObjects, normalizeSchemaDiffDependencyGraph, schemaDiffObjectSelectionState, selectSchemaDiffInput, selectSchemaDiffInputForObject, setSchemaDiffObjectSelected, setSchemaDiffObjectSelectedWithDependencies, type SchemaDiffPreparation } from "../../schema/schemaDiff";

function createPreparation(): SchemaDiffPreparation {
  return {
    diffs: [
      {
        type: "modified",
        objectType: "table",
        name: "table_a",
        columns: [
          { type: "added", name: "a_col" },
          { type: "added", name: "a_other_col" },
        ],
      },
      {
        type: "modified",
        objectType: "table",
        name: "table_b",
        columns: [{ type: "added", name: "b_col" }],
      },
    ],
    syncSql: "-- table_a and table_b",
  };
}

function createDuplicateForeignKeyPreparation(): SchemaDiffPreparation {
  return {
    diffs: [
      {
        type: "modified",
        objectType: "table",
        name: "orders",
        foreignKeys: [
          {
            type: "removed",
            name: "fk_customer",
            target: { name: "fk_customer", column: "legacy_customer_id", ref_table: "customers", ref_column: "id" },
          },
          {
            type: "added",
            name: "fk_customer",
            source: { name: "fk_customer", column: "customer_id", ref_table: "customers", ref_column: "id" },
          },
        ],
      },
    ],
    syncSql: "-- orders",
  };
}

describe("schema diff SQL selection projections", () => {
  it("keeps every composite foreign key column in the selection dependency closure", () => {
    const result = createPreparation();
    result.diffs[0]!.foreignKeys = [
      {
        type: "added",
        name: "fk_pair",
        source: {
          name: "fk_pair",
          column: "a_col, a_other_col",
          ref_table: "parent",
          ref_column: "id, code",
          column_pairs: [
            ["a_col", "id"],
            ["a_other_col", "code"],
          ],
        },
      },
    ];
    const objects = convertToSchemaDiffObjects(result.diffs);
    const foreignKey = objects[0]!.children!.find((child) => child.objectKind === "foreignKey")!;
    for (const column of ["a_col", "a_other_col"]) {
      setSchemaDiffObjectSelectedWithDependencies(objects, result, `col-table_a-${column}`, false);
      expect(foreignKey.selected).toBe(false);
      setSchemaDiffObjectSelectedWithDependencies(objects, result, foreignKey.id, true);
      expect(objects[0]!.children!.filter((child) => child.objectKind === "column").every((child) => child.selected)).toBe(true);
      expect(selectSchemaDiffInput(result, objects).diffs[0]!.foreignKeys![0]!.source!.column_pairs).toEqual([
        ["a_col", "id"],
        ["a_other_col", "code"],
      ]);
    }
  });

  it("selects a composite foreign key drop before removing either local column", () => {
    const result = createPreparation();
    result.diffs[0]!.columns!.forEach((column) => {
      column.type = "removed";
    });
    result.diffs[0]!.foreignKeys = [
      {
        type: "removed",
        name: "fk_pair",
        target: {
          name: "fk_pair",
          column: "a_col, a_other_col",
          ref_table: "parent",
          ref_column: "id, code",
          column_pairs: [
            ["a_col", "id"],
            ["a_other_col", "code"],
          ],
        },
      },
    ];
    const objects = convertToSchemaDiffObjects(result.diffs);
    const foreignKey = objects[0]!.children!.find((child) => child.objectKind === "foreignKey")!;
    for (const column of ["a_col", "a_other_col"]) {
      setSchemaDiffObjectSelected(objects, foreignKey.id, false);
      setSchemaDiffObjectSelectedWithDependencies(objects, result, `col-table_a-${column}`, true);
      expect(foreignKey.selected).toBe(true);
    }
  });

  it("keeps the focused table SQL separate from the full selected SQL", () => {
    const result = createPreparation();
    const objects = convertToSchemaDiffObjects(result.diffs);

    const selectedInput = selectSchemaDiffInput(result, objects);
    const focusedInput = selectSchemaDiffInputForObject(result, objects, "table-table_a");

    expect(selectedInput.diffs.map((diff) => diff.name)).toEqual(["table_a", "table_b"]);
    expect(focusedInput.diffs.map((diff) => diff.name)).toEqual(["table_a"]);
    expect(focusedInput.diffs[0]?.columns?.map((column) => column.name)).toEqual(["a_col", "a_other_col"]);
  });

  it("projects a child object without including sibling or parent changes", () => {
    const result = createPreparation();
    const objects = convertToSchemaDiffObjects(result.diffs);

    const focusedInput = selectSchemaDiffInputForObject(result, objects, "col-table_a-a_col");

    expect(focusedInput.diffs.map((diff) => diff.name)).toEqual(["table_a"]);
    expect(focusedInput.diffs[0]?.columns?.map((column) => column.name)).toEqual(["a_col"]);
  });

  it("updates the selected input after a checkbox change while leaving focused projection independent", () => {
    const result = createPreparation();
    const objects = convertToSchemaDiffObjects(result.diffs);

    setSchemaDiffObjectSelected(objects, "table-table_b", false);
    setSchemaDiffObjectSelected(objects, "col-table_a-a_col", false);

    const selectedInput = selectSchemaDiffInput(result, objects);
    const focusedInput = selectSchemaDiffInputForObject(result, objects, "table-table_a");

    expect(selectedInput.diffs.map((diff) => diff.name)).toEqual(["table_a"]);
    expect(selectedInput.diffs[0]?.columns?.map((column) => column.name)).toEqual(["a_other_col"]);
    expect(focusedInput.diffs[0]?.columns?.map((column) => column.name)).toEqual(["a_col", "a_other_col"]);
  });

  it("selects duplicate-name foreign keys independently and projects only the selected one", () => {
    const result = createDuplicateForeignKeyPreparation();
    const objects = convertToSchemaDiffObjects(result.diffs);
    const tableObject = objects[0]!;
    const [legacyForeignKey, currentForeignKey] = tableObject.children ?? [];
    const foreignKeyIds = tableObject.children?.map((child) => child.id) ?? [];

    expect(foreignKeyIds).toHaveLength(2);
    expect(new Set(foreignKeyIds).size).toBe(2);
    expect(schemaDiffObjectSelectionState(tableObject)).toEqual({ checked: true, indeterminate: false });

    expect(legacyForeignKey && setSchemaDiffObjectSelected(objects, legacyForeignKey.id, false)).toBe(true);
    expect(legacyForeignKey?.selected).toBe(false);
    expect(currentForeignKey?.selected).toBe(true);
    expect(tableObject.selected).toBe(false);
    expect(schemaDiffObjectSelectionState(tableObject)).toEqual({ checked: false, indeterminate: true });

    const selectedInput = selectSchemaDiffInput(result, objects);
    expect(selectedInput.diffs[0]?.foreignKeys?.map((foreignKey) => foreignKey.source?.column)).toEqual(["customer_id"]);

    expect(currentForeignKey && setSchemaDiffObjectSelected(objects, currentForeignKey.id, false)).toBe(true);
    expect(schemaDiffObjectSelectionState(tableObject)).toEqual({ checked: false, indeterminate: false });
    expect(selectSchemaDiffInput(result, objects).diffs).toEqual([]);

    const rebuiltObjects = convertToSchemaDiffObjects(result.diffs);
    expect(rebuiltObjects[0]?.children?.map((child) => child.id)).toEqual(foreignKeyIds);
  });

  it("returns an empty input for an object that is no longer present", () => {
    const result = createPreparation();
    const objects = convertToSchemaDiffObjects(result.diffs);

    expect(selectSchemaDiffInputForObject(result, objects, "missing-object")).toEqual({
      diffs: [],
      functionDiffs: [],
      sequenceDiffs: [],
      ruleDiffs: [],
      ownerDiffs: [],
    });
  });

  it("includes the complete predecessor closure in focused table SQL", () => {
    const result = createPreparation();
    result.diffs.push({
      type: "added",
      objectType: "table",
      name: "table_c",
    });
    result.dependencyGraph = {
      nodes: [
        { tableName: "table_a", dependsOn: ["table_b"], dependedBy: [] },
        { tableName: "table_b", dependsOn: ["table_c"], dependedBy: ["table_a"] },
        { tableName: "table_c", dependsOn: [], dependedBy: ["table_b"] },
      ],
    };
    const objects = convertToSchemaDiffObjects(result.diffs);

    const focusedInput = selectSchemaDiffInputForObject(result, objects, "table-table_a");

    expect(focusedInput.diffs.map((diff) => diff.name)).toEqual(["table_a", "table_b", "table_c"]);
  });

  it("normalizes the Rust dependency graph map and snake-case fields", () => {
    expect(
      normalizeSchemaDiffDependencyGraph({
        nodes: {
          table_a: { table_name: "table_a", depends_on: ["table_b"], depended_by: [] },
        },
      }),
    ).toEqual({
      nodes: [{ tableName: "table_a", dependsOn: ["table_b"], dependedBy: [] }],
    });
  });
});
