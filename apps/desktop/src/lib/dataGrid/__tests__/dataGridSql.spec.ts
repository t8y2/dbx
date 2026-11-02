import { describe, expect, it } from "vitest";
import { normalizeDataGridSaveError } from "@/lib/dataGrid/dataGridSql";

describe("normalizeDataGridSaveError", () => {
  it("extracts a message from an object-shaped save failure", () => {
    expect(normalizeDataGridSaveError("mysql", { message: "Duplicate entry for key id" })).toBe("Duplicate entry for key id");
  });

  it("extracts messages from nested backend request errors", () => {
    expect(normalizeDataGridSaveError("mysql", { error: { message: "Column count does not match" } })).toBe("Column count does not match");
  });

  it("keeps Error messages and database-specific guidance intact", () => {
    expect(normalizeDataGridSaveError("mysql", new Error("save failed"))).toBe("save failed");
    expect(normalizeDataGridSaveError("hive", new Error("Error 10294: update is disabled"))).toContain("Hive UPDATE/DELETE");
  });

  it("prefers the Error message over a backend envelope without detail", () => {
    const sqlError = Object.assign(new Error("Duplicate entry '1' for key 'PRIMARY'"), {
      backendError: {
        version: 1,
        code: "DBX-JDBC-4001",
        messageKey: "backendErrors.jdbc.sqlFailed",
        messageParams: { stage: "execute" },
        source: "jdbc_agent",
        operationOutcome: "unknown",
      },
    });
    expect(normalizeDataGridSaveError("mysql", sqlError)).toBe("Duplicate entry '1' for key 'PRIMARY'");
  });

  it("extracts messages from nested backendError envelopes", () => {
    expect(normalizeDataGridSaveError("mysql", { backendError: { message: "Connection refused" } })).toBe("Connection refused");
  });
});
