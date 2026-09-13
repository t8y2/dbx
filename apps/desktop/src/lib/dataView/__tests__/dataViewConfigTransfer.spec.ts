import { describe, expect, it } from "vitest";
import { buildDataViewExportFile, parseDataViewImportFile } from "../dataViewConfigTransfer";
import type { DataView } from "@/types/dataView";

function makeView(): DataView {
  return {
    id: "view-1",
    name: "Revenue",
    description: "Monthly revenue",
    defaultDisplayMode: "table",
    queries: [
      {
        id: "q1",
        title: "Total",
        connectionId: "conn-1",
        database: "prod",
        catalog: null,
        schema: null,
        sqlTemplate: "SELECT 1",
        kind: "query",
        displayMode: null,
        orderIndex: 0,
      },
    ],
    variables: [{ name: "region", label: "Region", kind: "string", inputType: "text", required: false }],
    ownerId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("buildDataViewExportFile", () => {
  it("wraps the view in a versioned envelope", () => {
    const view = makeView();
    const file = buildDataViewExportFile(view);
    expect(file.format).toBe("dbx-data-view");
    expect(file.version).toBe(1);
    expect(file.dataView).toEqual(view);
    expect(() => new Date(file.exportedAt).toISOString()).not.toThrow();
  });
});

describe("parseDataViewImportFile", () => {
  it("round-trips a valid export through stringify/parse", () => {
    const view = makeView();
    const json = JSON.stringify(buildDataViewExportFile(view));
    expect(parseDataViewImportFile(json)).toEqual(view);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseDataViewImportFile("not json")).toThrow();
  });

  it("rejects a well-formed JSON file with the wrong format tag", () => {
    expect(() => parseDataViewImportFile(JSON.stringify({ format: "something-else", dataView: makeView() }))).toThrow();
  });

  it("rejects a file missing the dataView payload", () => {
    expect(() => parseDataViewImportFile(JSON.stringify({ format: "dbx-data-view", version: 1 }))).toThrow();
  });

  it("rejects a dataView with non-array queries/variables", () => {
    const view = { ...makeView(), queries: "not-an-array" };
    expect(() => parseDataViewImportFile(JSON.stringify({ format: "dbx-data-view", version: 1, dataView: view }))).toThrow();
  });
});
