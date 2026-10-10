import { describe, expect, it } from "vitest";
import { inlineQueryResultEntries } from "./inlineQueryResultEntries";
import type { QueryResult, QueryResultRun, QueryTab } from "@/types/database";
const sql = "select 1;\nselect 2;";
const first = (value = 1): QueryResult => ({ columns: ["one"], rows: [[value]], affected_rows: 0, execution_time_ms: 1, sourceStatement: "select 1;", sourceFrom: 0, sourceTo: 9 });
const second = (): QueryResult => ({ ...first(2), sourceStatement: "select 2;", sourceFrom: 10, sourceTo: 19 });
const run = (sequence: number, results: QueryResult[]): QueryResultRun => ({ id: `run-${sequence}`, title: "", sequence, sql, createdAt: sequence, results, result: results[0], inlineRetained: true });
function tab(runs: QueryResultRun[]): QueryTab {
  const active = runs[runs.length - 1]!;
  return { id: "query", title: "", mode: "query", connectionId: "conn", database: "db", sql, isExecuting: false, resultRuns: runs, activeResultRunId: active.id, result: active.result, results: active.results };
}
describe("statement result slots across executions", () => {
  it("keeps the previous run intact while a single statement payload is published", () => {
    const item = tab([run(1, [first(), second()])]);
    item.isExecuting = true;
    item.result = first(11);
    item.results = [item.result];
    expect(inlineQueryResultEntries(item).map(({ result }) => result.rows[0]?.[0])).toEqual([1, 2]);
    item.resultRuns!.push(run(2, [item.result]));
    item.activeResultRunId = "run-2";
    item.isExecuting = false;
    expect(inlineQueryResultEntries(item).map(({ result }) => result.rows[0]?.[0])).toEqual([11, 2]);
  });
  it("keeps earlier statement results when the next statement executes separately", () => {
    const entries = inlineQueryResultEntries(tab([run(1, [first()]), run(2, [second()])]));
    expect(entries.map(({ result }) => result.rows[0]?.[0])).toEqual([1, 2]);
    expect(entries.map(({ run, index }) => [run?.id, index])).toEqual([
      ["run-1", 0],
      ["run-2", 0],
    ]);
  });
  it("updates only the rerun statement after an execution of the whole script", () => {
    const entries = inlineQueryResultEntries(tab([run(1, [first(), second()]), run(2, [first(11)])]));
    expect(entries.map(({ result }) => result.rows[0]?.[0])).toEqual([11, 2]);
    expect(entries.map(({ run, index }) => [run?.id, index])).toEqual([
      ["run-2", 0],
      ["run-1", 1],
    ]);
  });
  it("does not revert newer statement results when an older run is activated for paging", () => {
    const item = tab([run(1, [first(), second()]), run(2, [first(11)])]);
    item.activeResultRunId = "run-1";
    item.result = item.resultRuns![0]!.results![1];
    item.results = item.resultRuns![0]!.results;
    expect(inlineQueryResultEntries(item).map(({ result }) => result.rows[0]?.[0])).toEqual([11, 2]);
  });
  it("retains positions adjusted by editing and replaces an edited statement's slot", () => {
    const a = first();
    const b = second();
    const item = tab([run(1, [a, b])]);
    item.sql = "select 111;\nselect 2;";
    const updated = { ...first(111), sourceStatement: "select 111;", sourceTo: 11 };
    item.resultRuns!.push(run(2, [updated]));
    item.activeResultRunId = "run-2";
    item.result = updated;
    item.results = [updated];
    const entries = inlineQueryResultEntries(item, [
      { from: 0, to: 11, result: a },
      { from: 12, to: 21, result: b },
    ]);
    expect(entries.map(({ result }) => result.rows[0]?.[0])).toEqual([111, 2]);
    expect(entries.map(({ from, to }) => [from, to])).toEqual([
      [0, 11],
      [12, 21],
    ]);
  });
});
