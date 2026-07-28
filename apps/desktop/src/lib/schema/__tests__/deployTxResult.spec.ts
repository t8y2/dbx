import { describe, expect, it } from "vitest";
import { buildDeployTxResult } from "@/lib/schema/deployTxResult";

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
