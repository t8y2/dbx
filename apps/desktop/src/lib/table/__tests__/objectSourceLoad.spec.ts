import { describe, expect, it, vi } from "vitest";
import { loadEditableObjectSourceForEditor, loadObjectSourceWithRoutineFallback } from "@/lib/table/objectSourceLoad";
import { jdbcRoutineMetadata } from "@/lib/table/routineParameters";
import type { ObjectSource } from "@/types/database";

function source(text: string): ObjectSource {
  return { name: "x", object_type: "PROCEDURE", schema: "APP", source: text };
}

describe("loadObjectSourceWithRoutineFallback", () => {
  it("returns the primary source when it has content", async () => {
    const getObjectSource = vi.fn().mockResolvedValue(source("CREATE PROCEDURE ..."));
    const result = await loadObjectSourceWithRoutineFallback(getObjectSource, "c1", "ORCL", "APP", "P1", "PROCEDURE");
    expect(result.objectType).toBe("PROCEDURE");
    expect(result.source.source).toContain("CREATE PROCEDURE");
    expect(getObjectSource).toHaveBeenCalledTimes(1);
  });

  it("falls back from PROCEDURE to FUNCTION when primary source is empty", async () => {
    const getObjectSource = vi
      .fn()
      .mockResolvedValueOnce(source(""))
      .mockResolvedValueOnce({ ...source("CREATE FUNCTION ..."), object_type: "FUNCTION" });
    const result = await loadObjectSourceWithRoutineFallback(getObjectSource, "c1", "ORCL", "APP", "F1", "PROCEDURE");
    expect(result.objectType).toBe("FUNCTION");
    expect(result.source.source).toContain("CREATE FUNCTION");
    expect(getObjectSource).toHaveBeenCalledTimes(2);
    expect(getObjectSource.mock.calls[1][4]).toBe("FUNCTION");
  });

  it("keeps a source-less routine response when structured metadata is present", async () => {
    const getObjectSource = vi.fn().mockResolvedValue({ ...source(""), editable: false, routine_parameters: [] });
    const result = await loadObjectSourceWithRoutineFallback(getObjectSource, "c1", "catalog", "APP", "P1", "PROCEDURE");

    expect(result.objectType).toBe("PROCEDURE");
    expect(result.source.routine_parameters).toEqual([]);
    expect(getObjectSource).toHaveBeenCalledTimes(1);
  });
});

describe("jdbcRoutineMetadata", () => {
  it("keeps legacy payloads optional and normalizes sorted JDBC display metadata", () => {
    expect(jdbcRoutineMetadata(undefined)).toBeNull();
    expect(
      jdbcRoutineMetadata([
        { name: "p_note", mode: "OUT", jdbc_type: 12, type_name: "VARCHAR", length: 64, nullable: true, ordinal: 3 },
        { name: null, mode: "RETURN", jdbc_type: 3, type_name: "DECIMAL", precision: 12, scale: 3, ordinal: 0 },
        { name: "p_id", mode: "IN", jdbc_type: -5, type_name: "BIGINT", nullable: false, ordinal: 1 },
        { name: null, mode: "INOUT", jdbc_type: null, type_name: null, nullable: null, ordinal: 2 },
        { name: "p_unknown", mode: "UNKNOWN" },
      ]),
    ).toEqual({
      returnType: "DECIMAL(12,3)",
      parameters: [
        { name: "p_id", dataType: "BIGINT", mode: "IN", ordinal: 1, hasDefault: false, nullable: false },
        { name: "arg2", dataType: "UNKNOWN", mode: "INOUT", ordinal: 2, hasDefault: false, nullable: null },
        { name: "p_note", dataType: "VARCHAR(64)", mode: "OUT", ordinal: 3, hasDefault: false, nullable: true },
        { name: "p_unknown", dataType: "UNKNOWN", mode: "UNKNOWN", ordinal: 4, hasDefault: false, nullable: undefined },
      ],
    });
  });
});

describe("loadEditableObjectSourceForEditor", () => {
  it("wraps bare Oracle procedure source for the editor", async () => {
    const raw = "procedure BMS_SA_SETTOREC_PK is\nbegin\n  null;\nend;";
    const getObjectSource = vi.fn().mockResolvedValue(source(raw));
    const buildEditableObjectSource = vi.fn().mockImplementation(async (input) => `CREATE OR REPLACE ${input.source}`);

    const result = await loadEditableObjectSourceForEditor(getObjectSource, buildEditableObjectSource, {
      connectionId: "c1",
      database: "ORCL",
      schema: "APP",
      name: "BMS_SA_SETTOREC_PK",
      objectType: "PROCEDURE",
      databaseType: "oracle",
    });

    expect(result.editableSource).toBe(`CREATE OR REPLACE ${raw}`);
    expect(buildEditableObjectSource).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseType: "oracle",
        objectType: "PROCEDURE",
        name: "BMS_SA_SETTOREC_PK",
        source: raw,
      }),
    );
  });
});
