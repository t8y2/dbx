import { describe, expect, it, vi } from "vitest";
import { buildDeployTxResult, executeSchemaDiffRoutineDeployment, finishSchemaDiffDeployment, schemaDiffRoutineExecutionStatements, schemaDiffRoutineExecutedSteps, schemaDiffRoutineExpectedDefinitions } from "@/lib/schema/deployTxResult";
import type { FunctionDiff, SchemaDiffRoutineStep } from "@/lib/schema/schemaDiff";

const t = (key: string, params?: Record<string, any>) => {
  const fallback: Record<string, string> = {
    "diff.executeSuccess": "Executed successfully",
    "diff.deployMixed": "Deployment partially completed. Some statements may already be applied ({executedCount}/{statementCount}). DDL may not be transactional.",
    "diff.deployRolledBack": "All changes have been rolled back.",
    "diff.deployFailed": "Deployment failed: {status}",
  };
  let msg = fallback[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replace(`{${k}}`, String(v));
    }
  }
  return msg;
};

describe("buildDeployTxResult", () => {
  it("returns success for committed transaction", () => {
    const result = buildDeployTxResult({ status: "committed", transaction_id: "tx1", executedCount: 2 }, t);
    expect(result.success).toBe(true);
    expect(result.status).toBe("committed");
    expect(result.message).toBe("Executed successfully");
    expect(result.executedCount).toBe(2);
  });

  it("returns failure with mixed status for partially committed", () => {
    const result = buildDeployTxResult(
      {
        status: "mixed",
        participants: [{ id: "1" }, { id: "2" }],
        executedCount: 1,
        statementCount: 2,
      },
      t,
    );
    expect(result.success).toBe(false);
    expect(result.status).toBe("mixed");
    expect(result.message).toContain("partially completed");
    expect(result.message).toContain("1/2");
    expect(result.message).toContain("may not be transactional");
    expect(result.executedCount).toBe(1);
    expect(result.statementCount).toBe(2);
  });

  it("returns failure with rolled_back status and error detail", () => {
    const result = buildDeployTxResult({ status: "rolled_back", error: "syntax error near SELECT", executedCount: 0, statementCount: 2 }, t);
    expect(result.success).toBe(false);
    expect(result.status).toBe("rolled_back");
    expect(result.message).toContain("rolled back");
    expect(result.message).toContain("syntax error");
    expect(result.executedCount).toBe(0);
    expect(result.statementCount).toBe(2);
  });

  it("returns failure for unknown status", () => {
    const result = buildDeployTxResult({ status: "unknown" }, t);
    expect(result.success).toBe(false);
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("unknown");
  });

  it("returns failure for null/undefined txLog", () => {
    const result = buildDeployTxResult(null, t);
    expect(result.success).toBe(false);
    expect(result.status).toBe("unknown");
  });

  it("maps MySQL-style partial DDL failure (1 of 2 applied) for UI", () => {
    const result = buildDeployTxResult(
      {
        status: "mixed",
        executedCount: 1,
        statementCount: 2,
        error: "Statement 2 failed: table already exists",
        metadata: { atomicity: "partial_effects_possible", ddl_atomic: false },
      },
      t,
    );
    expect(result.success).toBe(false);
    expect(result.status).toBe("mixed");
    expect(result.executedCount).toBe(1);
    expect(result.statementCount).toBe(2);
    expect(result.message).toContain("1/2");
    expect(result.message).toMatch(/may already be applied|may not be transactional/i);
  });
});

describe("routine deployment readback", () => {
  it.each(["ENABLED", "DISABLED"])("creates a %s trigger disabled and verifies before optional activation", async (status) => {
    const trigger = { tableOwner: "DST", tableName: "T1", timing: "BEFORE", event: "INSERT", status, baseObjectType: "TABLE" };
    const diff: FunctionDiff = { name: "TR", type: "added", source: { name: "TR", function_type: "TRIGGER", data_type: "", arguments: "", schema: "DST", definition: "old source", trigger } };
    const step: SchemaDiffRoutineStep = { name: "TR", routineType: "TRIGGER", operation: "added", sql: "CREATE TRIGGER TR BEFORE INSERT ON T1 DISABLE BEGIN NULL; END;", dependencies: [], trigger, postSql: status === "ENABLED" ? ["ALTER TRIGGER TR ENABLE;"] : [] };
    const order: string[] = [];
    const execute = vi.fn(async (statements: string[]) => {
      order.push(statements[0]!);
      return { status: "committed", executedCount: statements.length };
    });
    const validate = vi.fn(async (diffs: FunctionDiff[]) => {
      const actual = diffs[0]!.source!;
      order.push(`verify ${actual.trigger!.status}`);
      return [{ name: "TR", routineType: "TRIGGER", schema: "DST", success: true, message: "VALID", trigger: actual.trigger }];
    });
    const result = await executeSchemaDiffRoutineDeployment([step], [diff], execute, validate, t, false, "DST");
    expect(result.success).toBe(true);
    expect(order).toEqual(status === "ENABLED" ? [step.sql, "verify DISABLED", "ALTER TRIGGER TR ENABLE;", "verify ENABLED"] : [step.sql, "verify DISABLED"]);
    expect(diff.source!.trigger!.status).toBe(status);
  });

  it("leaves a trigger disabled when compile/source readback fails", async () => {
    const trigger = { tableOwner: "DST", tableName: "T1", timing: "BEFORE", event: "INSERT", status: "ENABLED", baseObjectType: "TABLE" };
    const diff: FunctionDiff = { name: "TR", type: "added", source: { name: "TR", function_type: "TRIGGER", data_type: "", arguments: "", definition: "source", trigger } };
    const step: SchemaDiffRoutineStep = { name: "TR", routineType: "TRIGGER", operation: "added", sql: "CREATE TRIGGER TR DISABLE BEGIN NULL; END;", postSql: ["ALTER TRIGGER TR ENABLE;"], dependencies: [] };
    const execute = vi.fn().mockResolvedValue({ status: "committed", executedCount: 1 });
    const validate = vi.fn().mockResolvedValue([{ name: "TR", routineType: "TRIGGER", success: false, message: "INVALID", trigger: { ...trigger, status: "DISABLED" } }]);
    const result = await executeSchemaDiffRoutineDeployment([step], [diff], execute, validate, t);
    expect(result.success).toBe(false);
    expect(result.executedCount).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith([step.sql]);
  });
  it.each(["PACKAGE", "TYPE"] as const)("validates mapped %s and body definitions without overwriting source or recovery snapshots", async (kind) => {
    const bodyKind = kind === "TYPE" ? "TYPE BODY" : "PACKAGE BODY";
    const definition = kind === "TYPE" ? "AS TABLE OF SRC.Parent;" : "AS FUNCTION f RETURN NUMBER; END;";
    const bodyDefinition = `${kind === "TYPE" ? "MEMBER " : ""}FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; END;`;
    const source = { name: "Same.Object", function_type: kind, data_type: "", arguments: "", schema: "SRC", definition: `CREATE EDITIONABLE ${kind} "Same.Object" ${definition}` };
    const body = { ...source, function_type: bodyKind, definition: `CREATE ${bodyKind} "Same.Object" AS ${bodyDefinition}` };
    const diffs: FunctionDiff[] = [
      { name: source.name, type: "modified", source, target: { ...source, schema: "DST", definition: "original target specification" } },
      { name: source.name, type: "modified", source: body, target: { ...body, schema: "DST", definition: "original target body" } },
    ];
    const steps: SchemaDiffRoutineStep[] = [
      { name: source.name, routineType: kind, operation: "modified", sql: `CREATE OR REPLACE ${kind} "DST"."Same.Object" ${definition.replace("SRC.", '"DST".')}`, dependencies: [] },
      { name: source.name, routineType: bodyKind, operation: "modified", sql: `CREATE OR REPLACE ${bodyKind} "DST"."Same.Object" AS ${bodyDefinition}`, dependencies: [] },
    ];
    const forward = schemaDiffRoutineExpectedDefinitions(diffs, steps);
    expect(forward[0]!.source!.definition).toBe(steps[0]!.sql);
    expect(forward[1]!.source!.definition).toBe(steps[1]!.sql);
    expect(forward[0]!.target!.definition).toBe("original target specification");
    expect(diffs[0]!.source!.definition).toBe(source.definition);
    const validate = vi.fn().mockResolvedValue([]);
    await finishSchemaDiffDeployment({ status: "committed" }, forward, validate, t, false, "DST");
    expect(validate).toHaveBeenCalledWith(forward);
    const recoverySteps = steps.map((step) => ({ ...step, sql: `restore ${step.routineType}` }));
    const recovery = schemaDiffRoutineExpectedDefinitions(diffs, recoverySteps, true);
    expect(recovery[0]!.target!.definition).toBe(`restore ${kind}`);
    expect(recovery[1]!.target!.definition).toBe(`restore ${bodyKind}`);
    expect(recovery[0]!.source!.definition).toBe(source.definition);
    expect(diffs[0]!.target!.definition).toBe("original target specification");
  });
  it("keeps compound trigger bodies intact and applies status separately in plan order", () => {
    const ddl = "CREATE OR REPLACE TRIGGER T COMPOUND TRIGGER BEFORE STATEMENT IS BEGIN NULL; END BEFORE STATEMENT; END;";
    const steps: SchemaDiffRoutineStep[] = [
      { name: "P", routineType: "PACKAGE", operation: "added", sql: "CREATE OR REPLACE PACKAGE P AS END;", dependencies: [] },
      { name: "P", routineType: "PACKAGE BODY", operation: "added", sql: "CREATE OR REPLACE PACKAGE BODY P AS END;", dependencies: [] },
      { name: "T", routineType: "TRIGGER", operation: "added", sql: ddl, postSql: ["ALTER TRIGGER T DISABLE"], dependencies: [] },
    ];
    expect(schemaDiffRoutineExecutionStatements(steps)).toEqual([steps[0]!.sql, steps[1]!.sql, ddl, "ALTER TRIGGER T DISABLE"]);
    expect(schemaDiffRoutineExecutedSteps(steps, 3)).toEqual(["PACKAGE P", "PACKAGE BODY P", "TRIGGER T"]);
    expect(() => schemaDiffRoutineExecutionStatements([{ ...steps[0]!, blockedReason: "Missing package body source" }])).toThrow();
  });

  it("requires distinct package-body readback and the exact trigger relation", async () => {
    const base = { name: "SAME", data_type: "", arguments: "", definition: "body", schema: "SRC" };
    const trigger = { tableOwner: "SRC", tableName: "T1", timing: "BEFORE", event: "INSERT", status: "DISABLED", baseObjectType: "TABLE" };
    const diffs: FunctionDiff[] = [
      { name: "SAME", type: "added", source: { ...base, function_type: "PACKAGE" } },
      { name: "SAME", type: "added", source: { ...base, function_type: "PACKAGE BODY" } },
      { name: "SAME", type: "added", source: { ...base, function_type: "TRIGGER", trigger } },
    ];
    const rows = [
      { name: "SAME", routineType: "PACKAGE", success: true, message: "VALID" },
      { name: "SAME", routineType: "PACKAGE BODY", success: true, message: "VALID" },
      { name: "SAME", routineType: "TRIGGER", success: true, message: "VALID", trigger: { ...trigger, tableOwner: "DST" } },
    ];
    expect((await finishSchemaDiffDeployment({ status: "committed" }, diffs, vi.fn().mockResolvedValue(rows), t, false, "DST")).success).toBe(true);
    expect((await finishSchemaDiffDeployment({ status: "committed" }, diffs, vi.fn().mockResolvedValue(rows.filter((item) => item.routineType !== "PACKAGE BODY")), t, false, "DST")).success).toBe(false);
    rows[2]!.trigger!.tableName = "T2";
    expect((await finishSchemaDiffDeployment({ status: "committed" }, diffs, vi.fn().mockResolvedValue(rows), t, false, "DST")).success).toBe(false);
  });

  const routine = { name: "P_SYNC", function_type: "PROCEDURE", data_type: "", arguments: "", definition: "CREATE PROCEDURE P_SYNC AS BEGIN NULL; END;", schema: "SRC" };
  const expected: FunctionDiff[] = [{ name: routine.name, type: "added", source: routine }];

  it("distinguishes an external same-named caller while still requiring its validation", async () => {
    const rows = [
      { name: routine.name, schema: "DST", routineType: "PROCEDURE", success: true, message: "VALID" },
      { name: routine.name, schema: "OTHER", routineType: "PROCEDURE", success: true, message: "Caller VALID" },
    ];
    expect((await finishSchemaDiffDeployment({ status: "committed" }, expected, vi.fn().mockResolvedValue(rows), t, false, "DST")).success).toBe(true);
    rows[1]!.success = false;
    expect((await finishSchemaDiffDeployment({ status: "committed" }, expected, vi.fn().mockResolvedValue(rows), t, false, "DST")).success).toBe(false);
    expect((await finishSchemaDiffDeployment({ status: "committed" }, expected, vi.fn().mockResolvedValue(rows.slice(1)), t, false, "DST")).success).toBe(false);
  });

  it("reports success only after every selected routine passes compilation and source readback", async () => {
    const validate = vi.fn().mockResolvedValue([{ name: routine.name, routineType: "PROCEDURE", success: true, message: "VALID; source matches" }]);
    const result = await finishSchemaDiffDeployment({ status: "committed" }, expected, validate, t);
    expect(validate).toHaveBeenCalledWith(expected);
    expect(result.success).toBe(true);
    expect(result.routineValidations?.[0]?.message).toBe("VALID; source matches");
  });

  it.each([
    { label: "INVALID", rows: [{ name: routine.name, routineType: "PROCEDURE", success: false, message: "PLS-00201: identifier missing" }] },
    { label: "missing readback", rows: [] },
    { label: "wrong routine", rows: [{ name: "OTHER", routineType: "PROCEDURE", success: true, message: "VALID" }] },
  ])("does not report success for committed DDL with $label", async ({ rows }) => {
    const result = await finishSchemaDiffDeployment({ status: "committed", executedCount: 1 }, expected, vi.fn().mockResolvedValue(rows), t);
    expect(result.success).toBe(false);
    expect(result.status).toBe("validation_failed");
    expect(result.executedCount).toBe(1);
  });

  it("retains a metadata permission error without claiming rollback", async () => {
    const result = await finishSchemaDiffDeployment({ status: "committed" }, expected, vi.fn().mockRejectedValue(new Error("ORA-01031")), t);
    expect(result.success).toBe(false);
    expect(result.status).toBe("validation_failed");
    expect(result.error).toBe("ORA-01031");
  });

  it("does not validate an uncommitted or cancelled deployment", async () => {
    const validate = vi.fn();
    expect((await finishSchemaDiffDeployment({ status: "mixed" }, expected, validate, t)).success).toBe(false);
    expect(validate).not.toHaveBeenCalled();
  });

  it("validates rollback against the previous target and verifies rolled-back additions are absent", async () => {
    const target = { ...routine, schema: "DST", definition: "previous definition" };
    const diffs: FunctionDiff[] = [...expected, { name: "P_OLD", type: "removed", target }, { name: "P_CHANGED", type: "modified", source: routine, target }];
    const validate = vi.fn().mockResolvedValue([]);
    await finishSchemaDiffDeployment({ status: "committed" }, diffs, validate, t, true);
    expect(validate).toHaveBeenCalledWith([
      { ...expected[0], type: "removed", source: undefined, target: routine },
      { ...diffs[1], type: "added", source: target, target: undefined },
      { ...diffs[2], source: target, target: routine },
    ]);
  });
});
