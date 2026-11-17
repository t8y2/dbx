import { describe, expect, it } from "vitest";
import type { BatchSqlExecution, QueryResult, QueryTab } from "@/types/database";
import { hasQueryOutput } from "../queryOutput";

const emptyResult: QueryResult = { columns: ["id"], rows: [], affected_rows: 0, execution_time_ms: 1 };

describe("hasQueryOutput", () => {
  it("does not reserve output space for an idle query", () => {
    expect(hasQueryOutput(undefined)).toBe(false);
    expect(hasQueryOutput({ isExecuting: false, results: [], resultRuns: [] })).toBe(false);
  });

  it("retains a stopped batch without results and releases the output space when cleared", () => {
    const batch: BatchSqlExecution = {
      executionId: "stopped",
      submittedSql: "SELECT 1",
      editorFingerprint: "editor",
      sourceOffset: 0,
      completed: 0,
      total: 1,
      startedAt: 1,
      finishedAt: 2,
      items: [{ statementIndex: 0, sql: "SELECT 1", from: 0, to: 8, status: "skipped" }],
    };
    const tab = { isExecuting: false, batchSqlExecution: batch as BatchSqlExecution | undefined };
    expect(hasQueryOutput(tab)).toBe(true);
    tab.batchSqlExecution = { ...batch, items: [], total: 0 };
    expect(hasQueryOutput(tab)).toBe(false);
    tab.batchSqlExecution = undefined;
    expect(hasQueryOutput(tab)).toBe(false);
  });

  it.each<[string, Partial<QueryTab>]>([
    ["running query", { isExecuting: true }],
    ["running EXPLAIN", { isExplaining: true }],
    ["zero-row SELECT", { result: emptyResult }],
    ["DML summary", { result: { ...emptyResult, columns: [], affected_rows: 3 } }],
    ["DDL summary", { result: { ...emptyResult, columns: [] } }],
    ["query error", { result: { ...emptyResult, columns: ["Error"], rows: [["syntax error"]] } }],
    ["multiple results", { results: [emptyResult] }],
    ["retained result run", { resultRuns: [{ id: "run-1", title: "Result 1", sequence: 1, sql: "SELECT 1", createdAt: 1 }] }],
    ["EXPLAIN plan", { explainPlan: { databaseType: "mysql", raw: {}, nodes: [] } }],
    ["EXPLAIN table", { explainTableResult: emptyResult }],
    ["EXPLAIN error", { explainError: "syntax error" }],
    ["EXPLAIN table error", { explainTableError: "unsupported" }],
    ["cached result", { resultEvicted: true, resultCacheState: "disk" }],
    ["missing cached result", { resultEvicted: true, resultCacheState: "missing" }],
  ])("retains output space for %s", (_, state) => {
    expect(hasQueryOutput({ isExecuting: false, ...state })).toBe(true);
  });
});
