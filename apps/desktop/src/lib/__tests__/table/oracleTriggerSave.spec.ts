import { describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";
import { saveOracleTriggerDefinition } from "@/lib/table/oracleTriggerSave";

const original = "CREATE TRIGGER APP.T BEFORE INSERT ON APP.DATA FOR EACH ROW BEGIN NULL; END;";
const state = (valid = true, enabled = true) => ({ columns: [], rows: [[valid ? "VALID" : "INVALID", enabled ? "ENABLED" : "DISABLED", "APP", "DATA"]] }) as QueryResult;
const empty = { columns: [], rows: [] } as unknown as QueryResult;
function setup() {
  const execute = vi.fn<(sql: string) => Promise<QueryResult>>();
  const preserveOriginal = vi.fn();
  return { execute, preserveOriginal, schema: "APP", name: "T", tableSchema: "APP", tableName: "DATA", originalSource: original, source: original.replace("NULL", "dbms_output.put_line('changed')"), readSource: vi.fn().mockResolvedValue(original) };
}

describe("Oracle trigger replacement stages", () => {
  it("binds unqualified source to the verified trigger and table identities without changing recovery text", async () => {
    const options = setup();
    options.schema = "OTHER";
    options.originalSource = "CREATE TRIGGER T BEFORE INSERT ON DATA FOR EACH ROW BEGIN NULL; END;";
    options.source = options.originalSource;
    options.readSource.mockResolvedValue(options.originalSource);
    options.execute.mockResolvedValueOnce(state(true, false)).mockResolvedValueOnce(empty).mockResolvedValueOnce(state(true, false)).mockResolvedValueOnce(state(true, false));
    await saveOracleTriggerDefinition(options);
    expect(options.execute.mock.calls[0][0]).toContain("o.OWNER = 'OTHER'");
    expect(options.execute.mock.calls[1][0]).toContain('TRIGGER "OTHER".T');
    expect(options.execute.mock.calls[1][0]).toContain('ON "APP".DATA');
    expect(options.preserveOriginal).toHaveBeenCalledWith(options.originalSource, false);
  });

  it("does not qualify and replace an unqualified target until its actual table owner is confirmed", async () => {
    const options = setup();
    options.schema = "OTHER";
    options.source = "CREATE TRIGGER T BEFORE INSERT ON DATA FOR EACH ROW BEGIN NULL; END;";
    options.execute.mockResolvedValueOnce({ columns: [], rows: [["VALID", "DISABLED", "WRONG", "DATA"]] } as QueryResult);
    await expect(saveOracleTriggerDefinition(options)).rejects.toThrow("target differs");
    expect(options.execute).toHaveBeenCalledTimes(1);
    expect(options.preserveOriginal).not.toHaveBeenCalled();
  });

  it("preserves the old definition before DDL and restores enabled state only after VALID", async () => {
    const options = setup();
    options.execute.mockResolvedValueOnce(state()).mockImplementationOnce(async (sql) => {
      expect(options.preserveOriginal).toHaveBeenCalledWith(original, true);
      expect(sql).toContain("DISABLE\nBEGIN");
      expect(sql).not.toContain("DROP");
      return empty;
    }).mockResolvedValueOnce(state(true, false)).mockResolvedValueOnce(empty).mockResolvedValueOnce(state());
    await saveOracleTriggerDefinition(options);
    expect(options.execute.mock.calls[3][0]).toBe('ALTER TRIGGER "APP"."T" ENABLE');
  });

  it("keeps a previously disabled trigger disabled", async () => {
    const options = setup();
    options.execute.mockResolvedValueOnce(state(true, false)).mockResolvedValueOnce(empty).mockResolvedValueOnce(state(true, false)).mockResolvedValueOnce(state(true, false));
    await saveOracleTriggerDefinition(options);
    expect(options.execute.mock.calls.every(([sql]) => !sql.startsWith("ALTER TRIGGER"))).toBe(true);
  });

  it("reports compilation errors and stops before ENABLE after an INVALID replacement", async () => {
    const options = setup();
    options.execute.mockResolvedValueOnce(state()).mockResolvedValueOnce(empty).mockResolvedValueOnce(state(false, false)).mockResolvedValueOnce({ columns: [], rows: [[4, 9, "PLS-00201"]] } as QueryResult);
    await expect(saveOracleTriggerDefinition(options)).rejects.toThrow("4:9 PLS-00201");
    expect(options.execute.mock.calls.every(([sql]) => !sql.startsWith("ALTER TRIGGER"))).toBe(true);
    expect(options.preserveOriginal).toHaveBeenCalledWith(original, true);
  });

  it("does not modify a trigger changed after opening", async () => {
    const options = setup();
    options.execute.mockResolvedValueOnce(state());
    options.readSource.mockResolvedValueOnce(original.replace("NULL", "other_change"));
    await expect(saveOracleTriggerDefinition(options)).rejects.toThrow("changed since");
    expect(options.execute).toHaveBeenCalledTimes(1);
    expect(options.preserveOriginal).not.toHaveBeenCalled();
  });

  it("rejects target changes before issuing any SQL", async () => {
    const options = setup();
    options.source = options.source.replace("ON APP.DATA", "ON APP.OTHER");
    await expect(saveOracleTriggerDefinition(options)).rejects.toThrow("target differs");
    expect(options.execute).not.toHaveBeenCalled();
  });

  it("retains the original definition when CREATE reports a permission failure", async () => {
    const options = setup();
    options.execute.mockResolvedValueOnce(state()).mockRejectedValueOnce(new Error("ORA-01031"));
    await expect(saveOracleTriggerDefinition(options)).rejects.toThrow("ORA-01031");
    expect(options.preserveOriginal).toHaveBeenCalledWith(original, true);
    expect(options.execute).toHaveBeenCalledTimes(2);
  });

  it("does not report success when enabled-state readback differs", async () => {
    const options = setup();
    options.execute.mockResolvedValueOnce(state()).mockResolvedValueOnce(empty).mockResolvedValueOnce(state(true, false)).mockResolvedValueOnce(empty).mockResolvedValueOnce(state(true, false));
    await expect(saveOracleTriggerDefinition(options)).rejects.toThrow("enabled state could not be confirmed");
  });

  it("saves a compound trigger through the complete-source path", async () => {
    const options = setup();
    options.source = "CREATE TRIGGER APP.T FOR INSERT ON APP.DATA COMPOUND TRIGGER BEFORE STATEMENT IS BEGIN NULL; END BEFORE STATEMENT; END;";
    options.execute.mockResolvedValueOnce(state(true, false)).mockResolvedValueOnce(empty).mockResolvedValueOnce(state(true, false)).mockResolvedValueOnce(state(true, false));
    await saveOracleTriggerDefinition(options);
    expect(options.execute.mock.calls[1][0]).toContain("DISABLE\nCOMPOUND TRIGGER");
  });

  it("stops before DDL if the original cannot be persisted", async () => {
    const options = setup();
    options.execute.mockResolvedValueOnce(state());
    options.preserveOriginal.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(saveOracleTriggerDefinition(options)).rejects.toThrow("storage unavailable");
    expect(options.execute).toHaveBeenCalledTimes(1);
  });
});
