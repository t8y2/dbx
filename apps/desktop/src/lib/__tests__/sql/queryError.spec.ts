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

  it("detects agent RPC client-side timeout", () => {
    expect(isQueryTimeoutErrorMessage("Agent RPC call timed out (30s)")).toBe(true);
    expect(isQueryTimeoutErrorMessage("Agent RPC call timed out (120s)")).toBe(true);
    expect(isQueryTimeoutErrorMessage("Agent RPC error (-1): Agent RPC call timed out (120s)")).toBe(true);
  });

  it("detects structured query operation timeouts before localized text matching", () => {
    const timeoutError = {
      version: 1,
      code: "DBX-JDBC-2002",
      messageKey: "backendErrors.jdbc.operationTimedOut",
      messageParams: { stage: "execute" },
      source: "jdbcAgent",
      operationOutcome: "unknown" as const,
    } as const;

    expect(isQueryTimeoutErrorMessage("数据库操作超时（阶段：execute）。", timeoutError)).toBe(true);
    expect(isQueryTimeoutErrorMessage("Database operation timed out (stage: fetch).", { ...timeoutError, messageParams: { stage: "fetch" } })).toBe(true);
  });

  it("does not offer query timeout settings for structured infrastructure timeouts", () => {
    const timeoutError = {
      version: 1,
      code: "DBX-JDBC-2001",
      messageKey: "backendErrors.jdbc.operationTimedOut",
      messageParams: { stage: "connect" },
      source: "jdbcAgent",
      operationOutcome: "not_started" as const,
    } as const;

    expect(isQueryTimeoutErrorMessage("Database operation timed out (stage: connect).", timeoutError)).toBe(false);
  });

  it("does not classify unrelated errors as query timeouts", () => {
    expect(isQueryTimeoutErrorMessage('syntax error at or near "select"')).toBe(false);
    expect(isQueryTimeoutErrorMessage("Connection timed out while loading databases")).toBe(false);
    expect(isQueryTimeoutErrorMessage("PostgreSQL connection pool checkout timed out (5s)")).toBe(false);
    expect(isQueryTimeoutErrorMessage("Cancel request timed out after 10s.")).toBe(false);
    expect(isQueryTimeoutErrorMessage("HTTP tunnel script read timed out")).toBe(false);
    expect(isQueryTimeoutErrorMessage('invalid value for parameter "statement_timeout"')).toBe(false);
    // Agent RPC errors that are not timeouts must not trigger the action.
    expect(isQueryTimeoutErrorMessage('Agent RPC error (-1): syntax error at or near "select"')).toBe(false);
  });
});
