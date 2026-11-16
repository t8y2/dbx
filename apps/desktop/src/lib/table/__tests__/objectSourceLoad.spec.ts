import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadEditableObjectSourceForEditor, loadObjectSourceWithRoutineFallback } from "@/lib/table/objectSourceLoad";
import { jdbcRoutineMetadata } from "@/lib/table/routineParameters";
import type { ObjectSource } from "@/types/database";

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ prepareOracleTriggerSql: mocks.prepare }));

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

describe("exact trigger source loading", () => {
  const options = { connectionId: "c1", database: "catalog", schema: " Owner ", name: " Trigger ", objectType: "TRIGGER", databaseType: "oceanbase-oracle", metadataReadOptions: { identityMode: "exact", catalog: "catalog" } } as const;
  function rawTrigger(): ObjectSource {
    return {
      name: options.name,
      schema: options.schema,
      object_type: "TRIGGER",
      source: "TRIGGER ... /* 中文😀 */",
      trigger: {
        name: options.name,
        event: "INSERT",
        timing: "BEFORE EACH ROW",
        enabled: false,
        valid: false,
        oracle_metadata: {
          contractVersion: 1,
          identityMode: "exact",
          engine: "oceanbase-oracle",
          owner: options.schema,
          name: options.name,
          scope: "VIEW",
          parent: { owner: " Parent Owner ", name: " View ", objectType: "VIEW" },
          objectId: "9007199254740993",
          definition: { origin: "ALL_SOURCE", format: "declaration", complete: true },
          reads: { identity: { state: "available" }, definition: { state: "available" } },
        },
      },
    };
  }
  beforeEach(() => {
    mocks.prepare.mockReset();
    mocks.prepare.mockResolvedValue({ definition: "CREATE TRIGGER ... /* 中文😀 */;", header: { scope: "RELATION", owner: " Parent Owner ", name: " View ", viewOnly: true, pluggable: false }, requiresStateRestore: false });
  });

  it("keeps raw metadata and source and forwards exact read options to the existing source API", async () => {
    const raw = rawTrigger();
    const read = vi.fn().mockResolvedValue(raw);
    const legacyFormatter = vi.fn();
    const loaded = await loadEditableObjectSourceForEditor(read, legacyFormatter, options);
    expect(read).toHaveBeenCalledWith("c1", "catalog", " Owner ", " Trigger ", "TRIGGER", undefined, undefined, options.metadataReadOptions);
    expect(loaded.raw).toBe(raw);
    expect(loaded.triggerSource?.complete).toBe(true);
    expect(loaded.editableSource).toBe("CREATE TRIGGER ... /* 中文😀 */;");
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ owner: " Owner ", name: " Trigger ", source: raw.source, purpose: "inspect", binding: { scope: "VIEW", owner: " Parent Owner ", name: " View " }, allowExportAppendix: false }));
    expect(legacyFormatter).not.toHaveBeenCalled();
  });

  it("allows only a metadata DDL export to carry its same-target state appendix", async () => {
    const raw = rawTrigger();
    raw.source = "CREATE TRIGGER ...; ALTER TRIGGER ... DISABLE;";
    raw.trigger!.oracle_metadata!.definition = { origin: "DBMS_METADATA", format: "ddl", complete: true };
    await loadEditableObjectSourceForEditor(vi.fn().mockResolvedValue(raw), vi.fn(), options);
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ source: raw.source, allowExportAppendix: true }));
  });

  it("retains a body-only or old provider response without promoting a generic formatter result", async () => {
    const bodyMetadata = rawTrigger().trigger!.oracle_metadata!;
    bodyMetadata.definition = { origin: "catalog-body", format: "body", complete: false };
    for (const metadata of [undefined, bodyMetadata]) {
      const raw = rawTrigger();
      raw.source = "BEGIN NULL; END;";
      raw.trigger!.oracle_metadata = metadata;
      const formatter = vi.fn().mockResolvedValue("CREATE TRIGGER guessed ...");
      const loaded = await loadEditableObjectSourceForEditor(vi.fn().mockResolvedValue(raw), formatter, options);
      expect(loaded.editableSource).toBe(raw.source);
      expect(loaded.triggerSource?.complete).toBe(false);
      expect(loaded.triggerSource?.error).toBeTruthy();
      expect(formatter).not.toHaveBeenCalled();
    }
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("manual completion cannot replace an incomplete or unreadable authoritative baseline", async () => {
    for (const failure of ["incomplete", "denied", "error"] as const) {
      const raw = rawTrigger();
      raw.trigger!.oracle_metadata!.reads.definition = { state: failure };
      const loaded = await loadEditableObjectSourceForEditor(vi.fn().mockResolvedValue(raw), vi.fn(), options);
      expect(loaded.triggerSource?.prepared).toBeDefined();
      expect(loaded.triggerSource?.complete).toBe(false);
      expect(loaded.raw.source).toBe(raw.source);
    }
  });

  it("keeps the candidate available when strict source or ON validation fails", async () => {
    const raw = rawTrigger();
    mocks.prepare.mockRejectedValue(new Error("ON target mismatch"));
    const loaded = await loadEditableObjectSourceForEditor(vi.fn().mockResolvedValue(raw), vi.fn(), options);
    expect(loaded.editableSource).toBe(raw.source);
    expect(loaded.triggerSource).toEqual({ complete: false, error: "ON target mismatch" });
  });

  it("does not bless a table definition for a dictionary database or timer scope", async () => {
    for (const scope of ["DATABASE", "TIMER"] as const) {
      const raw = rawTrigger();
      raw.trigger!.oracle_metadata!.scope = scope;
      raw.trigger!.oracle_metadata!.parent = null;
      const loaded = await loadEditableObjectSourceForEditor(vi.fn().mockResolvedValue(raw), vi.fn(), options);
      expect(loaded.triggerSource?.complete).toBe(false);
      expect(loaded.triggerSource?.error).toContain("scope does not match");
      expect(loaded.editableSource).toBe(raw.source);
    }
  });

  it("does not accept a near-name or parent owner as the trigger source identity", async () => {
    for (const wrong of ["Owner", " Parent Owner "]) {
      const raw = rawTrigger();
      raw.schema = wrong;
      const loaded = await loadEditableObjectSourceForEditor(vi.fn().mockResolvedValue(raw), vi.fn(), options);
      expect(loaded.triggerSource?.complete).toBe(false);
      expect(loaded.editableSource).toBe(raw.source);
    }
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("leaves default trigger callers on their original formatter contract", async () => {
    const read = vi.fn().mockResolvedValue(rawTrigger());
    const formatter = vi.fn().mockResolvedValue("legacy formatted trigger");
    const loaded = await loadEditableObjectSourceForEditor(read, formatter, { ...options, metadataReadOptions: undefined });
    expect(read.mock.calls[0]).toHaveLength(7);
    expect(loaded.editableSource).toBe("legacy formatted trigger");
    expect(loaded.triggerSource).toBeUndefined();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
