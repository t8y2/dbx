import { describe, expect, it, vi } from "vitest";
import { loadEditableObjectSourceForEditor, loadObjectSourceWithRoutineFallback } from "@/lib/table/objectSourceLoad";
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
