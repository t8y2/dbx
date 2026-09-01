import { describe, expect, it } from "vitest";
import { convertToSchemaDiffObjects, normalizeSchemaDiffDependencyGraph, selectSchemaDiffInput, selectSchemaDiffInputForObject, setSchemaDiffObjectSelected, type SchemaDiffPreparation } from "../../schema/schemaDiff";

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

describe("schema diff SQL selection projections", () => {
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
