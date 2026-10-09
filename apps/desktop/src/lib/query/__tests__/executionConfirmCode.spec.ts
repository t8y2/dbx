import { describe, expect, it } from "vitest";
import { EXECUTION_CONFIRM_CODE_LENGTH, createExecutionConfirmCode, matchesExecutionConfirmCode } from "@/lib/query/executionConfirmCode";

describe("executionConfirmCode", () => {
  it("generates a code of the documented length from an unambiguous alphabet", () => {
    for (let run = 0; run < 50; run += 1) {
      const code = createExecutionConfirmCode();
      expect(code).toHaveLength(EXECUTION_CONFIRM_CODE_LENGTH);
      // No 0/O/1/I look-alikes: the operator has to retype it from the screen.
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
    }
  });

  it("is deterministic for a given random source", () => {
    const sequence = () => {
      const values = [0, 0.5, 0.999, 0.25, 0.75, 0.1];
      let index = 0;
      return () => values[index++ % values.length]!;
    };
    expect(createExecutionConfirmCode(sequence())).toBe(createExecutionConfirmCode(sequence()));
    expect(createExecutionConfirmCode(() => 0)).toBe("AAAAAA");
  });

  it("tolerates case and surrounding spaces when matching", () => {
    expect(matchesExecutionConfirmCode("ab12cd", "AB12CD")).toBe(true);
    expect(matchesExecutionConfirmCode("  AB12CD ", "ab12cd")).toBe(true);
    expect(matchesExecutionConfirmCode("", "AB12CD")).toBe(false);
    expect(matchesExecutionConfirmCode("AB12CE", "AB12CD")).toBe(false);
  });

  it("never matches an empty code", () => {
    expect(matchesExecutionConfirmCode("", "")).toBe(false);
    expect(matchesExecutionConfirmCode("anything", "")).toBe(false);
  });
});
