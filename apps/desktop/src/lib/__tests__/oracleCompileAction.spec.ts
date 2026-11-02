import { describe, expect, it, vi } from "vitest";
import { runOracleCompileAction, type OracleCompileQueryRequest, type OracleCompileQueryResult } from "@/lib/database/oracleCompileAction";

/**
 * The Compile action's contract.
 *
 * Two things are load-bearing and cannot be checked from the components (which
 * 5k/7k lines of Vue make untestable): every statement really is built by
 * `oracleCompileSql`, and the success/invalid decision comes from the ALL_ERRORS
 * read-back rather than from the DDL's own (always successful) answer.
 */

/** Records every statement the action asked for and answers with the scripted results. */
function fakeRunQuery(results: Array<OracleCompileQueryResult | undefined> = []) {
  const calls: OracleCompileQueryRequest[] = [];
  const runQuery = vi.fn(async (request: OracleCompileQueryRequest) => {
    calls.push(request);
    return results.shift();
  });
  return { runQuery, calls };
}

const baseInput = { connectionId: "c1", database: "ob", schema: "APP", name: "DO_WORK", objectType: "PROCEDURE" } as const;

describe("runOracleCompileAction", () => {
  it("compiles the object, reads ALL_ERRORS back and reports success on an empty read-back", async () => {
    const { runQuery, calls } = fakeRunQuery([{ rows: [] }, { rows: [] }]);

    const outcome = await runOracleCompileAction({ ...baseInput, runQuery });

    expect(outcome).toEqual({ status: "success", sql: 'ALTER PROCEDURE "APP"."DO_WORK" COMPILE;' });
    expect(calls.map((call) => call.stage)).toEqual(["compile", "errors"]);
    expect(calls[0]).toMatchObject({ connectionId: "c1", database: "ob", schema: "APP", sql: 'ALTER PROCEDURE "APP"."DO_WORK" COMPILE;' });
    // The read-back filters by the owner exactly as the tree spells it (no upper-casing).
    expect(calls[1].sql).toBe("SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER = 'APP' AND NAME = 'DO_WORK' ORDER BY SEQUENCE");
  });

  it("reports the ALL_ERRORS diagnostics even though the compile itself answered success", async () => {
    const { runQuery } = fakeRunQuery([
      { rows: [] },
      {
        rows: [
          [7, 3, "PL/SQL: Statement ignored"],
          [9, 1, "PLS-00201: identifier 'X' must be declared"],
        ],
      },
    ]);

    const outcome = await runOracleCompileAction({ ...baseInput, runQuery });

    expect(outcome).toMatchObject({ status: "invalid", message: "LINE 7, COL 3: PL/SQL: Statement ignored\nLINE 9, COL 1: PLS-00201: identifier 'X' must be declared" });
  });

  it("keeps a mixed-case name and schema quoted as the dictionary spells them", async () => {
    const { runQuery, calls } = fakeRunQuery([{ rows: [] }, { rows: [] }]);

    await runOracleCompileAction({ ...baseInput, schema: "AppSchema", owner: "AppSchema", name: "doWork", objectType: "package-body", runQuery });

    expect(calls[0].sql).toBe('ALTER PACKAGE "AppSchema"."doWork" COMPILE BODY;');
    expect(calls[1].sql).toBe("SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER = 'AppSchema' AND NAME = 'doWork' ORDER BY SEQUENCE");
  });

  it("filters ALL_ERRORS by owner, not by the execution schema, when the caller separates them", async () => {
    const { runQuery, calls } = fakeRunQuery([{ rows: [] }, { rows: [] }]);

    await runOracleCompileAction({ ...baseInput, schema: "APP", owner: "PROD_OWNER", runQuery });

    expect(calls[0].sql).toBe('ALTER PROCEDURE "APP"."DO_WORK" COMPILE;');
    expect(calls[1].sql).toContain("OWNER = 'PROD_OWNER'");
  });

  it("omits the schema when the caller has none, and then reads back without an owner filter", async () => {
    const { runQuery, calls } = fakeRunQuery([{ rows: [] }, { rows: [] }]);

    const outcome = await runOracleCompileAction({ connectionId: "c1", database: "ob", schema: null, name: "DO_WORK", objectType: "FUNCTION", runQuery });

    expect(outcome.status).toBe("success");
    expect(calls[0].sql).toBe('ALTER FUNCTION "DO_WORK" COMPILE;');
    expect(calls[0].schema).toBeNull();
    expect(calls[1].sql).toBe("SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE NAME = 'DO_WORK' ORDER BY SEQUENCE");
  });

  it("never runs anything for an object kind Oracle cannot recompile", async () => {
    const { runQuery, calls } = fakeRunQuery();

    expect(await runOracleCompileAction({ ...baseInput, objectType: "sequence", runQuery })).toEqual({ status: "unsupported" });
    expect(await runOracleCompileAction({ ...baseInput, name: "   ", runQuery })).toEqual({ status: "unsupported" });
    expect(calls).toHaveLength(0);
  });

  it("reports a refused statement as blocked and stops before the read-back", async () => {
    // The production guard resolves undefined; the compile must not be reported as done.
    const { runQuery, calls } = fakeRunQuery([undefined]);

    const outcome = await runOracleCompileAction({ ...baseInput, runQuery });

    expect(outcome).toEqual({ status: "blocked", sql: 'ALTER PROCEDURE "APP"."DO_WORK" COMPILE;', stage: "compile" });
    expect(calls).toHaveLength(1);
  });

  it("reports a refused read-back as blocked rather than claiming success", async () => {
    const { runQuery } = fakeRunQuery([{ rows: [] }, undefined]);

    const outcome = await runOracleCompileAction({ ...baseInput, runQuery });

    expect(outcome).toMatchObject({ status: "blocked", stage: "errors", sql: "SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER = 'APP' AND NAME = 'DO_WORK' ORDER BY SEQUENCE" });
  });

  it("reports a compile failure with the exception's own message", async () => {
    const runQuery = vi.fn(async () => {
      throw new Error("ORA-00942: table or view does not exist");
    });

    const outcome = await runOracleCompileAction({ ...baseInput, runQuery });

    expect(outcome).toEqual({ status: "failed", stage: "compile", sql: 'ALTER PROCEDURE "APP"."DO_WORK" COMPILE;', message: "ORA-00942: table or view does not exist" });
  });

  it("reports a read-back failure as failed, so the caller shows the dialog instead of a success toast", async () => {
    let call = 0;
    const runQuery = vi.fn(async () => {
      call += 1;
      if (call === 1) return { rows: [] };
      throw new Error("ORA-01031: insufficient privileges");
    });

    const outcome = await runOracleCompileAction({ ...baseInput, runQuery });

    expect(outcome).toMatchObject({ status: "failed", stage: "errors", message: "ORA-01031: insufficient privileges" });
  });

  it("falls back to String() for a rejection that is not an Error", async () => {
    const runQuery = vi.fn(async () => {
      throw "agent offline";
    });

    expect(await runOracleCompileAction({ ...baseInput, runQuery })).toMatchObject({ status: "failed", stage: "compile", message: "agent offline" });
  });
});
