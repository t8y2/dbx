import { describe, expect, it } from "vitest";
import { isQueryTimeoutErrorMessage } from "@/lib/sql/queryError";

describe("isQueryTimeoutErrorMessage", () => {
  it("detects DBX query timeout messages", () => {
    expect(isQueryTimeoutErrorMessage("Query timed out after 30 seconds")).toBe(true);
    expect(isQueryTimeoutErrorMessage("查询超时 (60s)，请检查数据库连接是否正常")).toBe(true);
    expect(isQueryTimeoutErrorMessage("查詢逾時 (60s)，請檢查資料庫連線是否正常")).toBe(true);
  });

  it("detects statement timeout messages", () => {
    expect(isQueryTimeoutErrorMessage("ERROR: canceling statement due to statement timeout")).toBe(true);
    expect(isQueryTimeoutErrorMessage("ERROR: cancelling statement due to statement timeout")).toBe(true);
    expect(isQueryTimeoutErrorMessage("Statement timed out after 10 seconds")).toBe(true);
  });

  it("detects generic query execution timeout messages", () => {
    expect(isQueryTimeoutErrorMessage("SQL execution timed out after 30s")).toBe(true);
    expect(isQueryTimeoutErrorMessage("Execution Timeout Expired. The timeout period elapsed prior to completion of the operation.")).toBe(true);
    expect(isQueryTimeoutErrorMessage("Query exceeded maximum execution time")).toBe(true);
  });

  it("does not classify unrelated errors as query timeouts", () => {
    expect(isQueryTimeoutErrorMessage('syntax error at or near "select"')).toBe(false);
    expect(isQueryTimeoutErrorMessage("Connection timed out while loading databases")).toBe(false);
    expect(isQueryTimeoutErrorMessage("PostgreSQL connection pool checkout timed out (5s)")).toBe(false);
    expect(isQueryTimeoutErrorMessage("Cancel request timed out after 10s.")).toBe(false);
    expect(isQueryTimeoutErrorMessage("HTTP tunnel script read timed out")).toBe(false);
    expect(isQueryTimeoutErrorMessage('invalid value for parameter "statement_timeout"')).toBe(false);
  });
});
