import { describe, expect, it, vi } from "vitest";
import { buildDeployTxResult, finishSchemaDiffDeployment } from "@/lib/schema/deployTxResult";
import type { FunctionDiff } from "@/lib/schema/schemaDiff";

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
  const routine = { name: "P_SYNC", function_type: "PROCEDURE", data_type: "", arguments: "", definition: "CREATE PROCEDURE P_SYNC AS BEGIN NULL; END;", schema: "SRC" };
  const expected: FunctionDiff[] = [{ name: routine.name, type: "added", source: routine }];

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
