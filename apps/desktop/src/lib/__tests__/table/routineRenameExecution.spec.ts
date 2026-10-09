import { describe, expect, it, vi } from "vitest";
import { executeOceanBaseRoutineRenameSteps, RoutineRenameStepError, supportsSourceBackedRoutineRename } from "@/lib/table/objectSourceEditor";

const plan = ["preflight", "create", "validate", "grants", "cleanup"];

describe("OceanBase guarded routine rename", () => {
  it("enables standalone procedures and functions only", () => {
    expect(supportsSourceBackedRoutineRename("oceanbase-oracle", "PROCEDURE")).toBe(true);
    expect(supportsSourceBackedRoutineRename("oceanbase-oracle", "FUNCTION")).toBe(true);
    expect(supportsSourceBackedRoutineRename("oceanbase-oracle", "PACKAGE")).toBe(false);
  });

  it("runs all verification steps before removing the original", async () => {
    const execute = vi.fn().mockResolvedValue({});
    await executeOceanBaseRoutineRenameSteps(plan, execute);
    expect(execute.mock.calls.map(([sql]) => sql)).toEqual(plan);
  });

  it.each([1, 2, 3, 4, 5])("stops after failure in step %i and reports the exact stage", async (step) => {
    const execute = vi.fn().mockImplementation(async () => {
      if (execute.mock.calls.length === step) throw new Error("database failure");
      return {};
    });
    await expect(executeOceanBaseRoutineRenameSteps(plan, execute)).rejects.toMatchObject({ name: "RoutineRenameStepError", step, message: "database failure" });
    expect(execute).toHaveBeenCalledTimes(step);
  });

  it("treats an execution-error result as failure even when the API resolves", async () => {
    const execute = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({ execution_error: true, error: { detail: "INVALID routine" } });
    await expect(executeOceanBaseRoutineRenameSteps(plan, execute)).rejects.toBeInstanceOf(RoutineRenameStepError);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("rejects an old create-and-drop plan without sending any SQL", async () => {
    const execute = vi.fn();
    await expect(executeOceanBaseRoutineRenameSteps(["create", "drop"], execute)).rejects.toThrow("complete five-step");
    expect(execute).not.toHaveBeenCalled();
  });
});
