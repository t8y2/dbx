import { describe, expect, it } from "vitest";
import { AI_CONTEXT_DEFAULTS, AI_CONTEXT_HARD_CAPS, AI_QUERY_RESULT_PREVIEW_LIMITS, QUERY_RESULT_BUDGET_HEADROOM_CHARS, resolveAiContextLimits } from "@/lib/ai/aiContextLimits";

describe("AI_CONTEXT_DEFAULTS", () => {
  it("matches the values the AI context paths used before the policy layer", () => {
    expect(AI_CONTEXT_DEFAULTS).toEqual({
      textAttachmentMaxBytes: 48 * 1024,
      textAttachmentMaxChars: 12_000,
      textAttachmentMaxCount: 8,
      textAttachmentMaxTotalChars: 32_000,
      imageAttachmentMaxBytes: 5 * 1024 * 1024,
      imageAttachmentMaxCount: 4,
      imageAttachmentMaxTotalBytes: 12 * 1024 * 1024,
      selectionMaxChars: 12_000,
      selectionMaxCount: 8,
      selectionTotalChars: 32_000,
      queryResultMaxRows: 30,
    });
  });

  it("keeps the query-result preview detail caps unchanged", () => {
    expect(AI_QUERY_RESULT_PREVIEW_LIMITS).toEqual({
      maxValueChars: 200,
      maxSqlChars: 4_000,
      maxColumnChars: 200,
      columnBudgetChars: 2_000,
      maxLineChars: 1_200,
      maxRowLabelChars: 100,
      reservedTailChars: 200,
    });
    expect(QUERY_RESULT_BUDGET_HEADROOM_CHARS).toBe(400);
  });
});

describe("resolveAiContextLimits", () => {
  it("resolves the exact current defaults and derives the preview budget", () => {
    expect(resolveAiContextLimits()).toEqual({
      selectionMaxChars: 12_000,
      selectionMaxCount: 8,
      selectionTotalChars: 32_000,
      queryResultMaxRows: 30,
      queryResultBudgetChars: 11_600,
    });
    expect(resolveAiContextLimits({})).toEqual(resolveAiContextLimits());
  });

  it("applies an in-range override without touching the other dimensions", () => {
    const limits = resolveAiContextLimits({ selectionMaxChars: 20_000, queryResultMaxRows: 100 });
    expect(limits.selectionMaxChars).toBe(20_000);
    expect(limits.queryResultMaxRows).toBe(100);
    expect(limits.selectionMaxCount).toBe(AI_CONTEXT_DEFAULTS.selectionMaxCount);
    expect(limits.selectionTotalChars).toBe(AI_CONTEXT_DEFAULTS.selectionTotalChars);
    expect(limits.queryResultBudgetChars).toBe(20_000 - QUERY_RESULT_BUDGET_HEADROOM_CHARS);
  });

  it("clamps over-cap overrides to the hard caps", () => {
    const limits = resolveAiContextLimits({
      selectionMaxChars: 1_000_000,
      selectionMaxCount: 1_000,
      selectionTotalChars: 1_000_000,
      queryResultMaxRows: 10_000,
    });
    expect(limits).toEqual({
      selectionMaxChars: AI_CONTEXT_HARD_CAPS.selectionMaxChars,
      selectionMaxCount: AI_CONTEXT_HARD_CAPS.selectionMaxCount,
      selectionTotalChars: AI_CONTEXT_HARD_CAPS.selectionTotalChars,
      queryResultMaxRows: AI_CONTEXT_HARD_CAPS.queryResultMaxRows,
      queryResultBudgetChars: AI_CONTEXT_HARD_CAPS.selectionMaxChars - QUERY_RESULT_BUDGET_HEADROOM_CHARS,
    });
  });

  it("floors fractional values and raises zero to the minimum", () => {
    const limits = resolveAiContextLimits({ selectionMaxCount: 5.9, queryResultMaxRows: 0 });
    expect(limits.selectionMaxCount).toBe(5);
    expect(limits.queryResultMaxRows).toBe(1);
  });

  it("falls back to the defaults for undefined, non-finite or negative input", () => {
    for (const invalid of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      const limits = resolveAiContextLimits({
        selectionMaxChars: invalid,
        selectionMaxCount: invalid,
        selectionTotalChars: invalid,
        queryResultMaxRows: invalid,
      });
      expect(limits).toEqual({
        selectionMaxChars: AI_CONTEXT_DEFAULTS.selectionMaxChars,
        selectionMaxCount: AI_CONTEXT_DEFAULTS.selectionMaxCount,
        selectionTotalChars: AI_CONTEXT_DEFAULTS.selectionTotalChars,
        queryResultMaxRows: AI_CONTEXT_DEFAULTS.queryResultMaxRows,
        queryResultBudgetChars: AI_CONTEXT_DEFAULTS.selectionMaxChars - QUERY_RESULT_BUDGET_HEADROOM_CHARS,
      });
    }
  });

  it("keeps the derived preview budget at least 1 even for a cap below the headroom", () => {
    expect(resolveAiContextLimits({ selectionMaxChars: 1 }).queryResultBudgetChars).toBe(1);
    expect(resolveAiContextLimits({ selectionMaxChars: QUERY_RESULT_BUDGET_HEADROOM_CHARS }).queryResultBudgetChars).toBe(1);
    expect(resolveAiContextLimits({ selectionMaxChars: QUERY_RESULT_BUDGET_HEADROOM_CHARS + 1 }).queryResultBudgetChars).toBe(1);
    expect(resolveAiContextLimits({ selectionMaxChars: QUERY_RESULT_BUDGET_HEADROOM_CHARS + 2 }).queryResultBudgetChars).toBe(2);
  });

  it("returns a fresh object and never mutates the shared defaults", () => {
    const snapshot = { ...AI_CONTEXT_DEFAULTS };
    const first = resolveAiContextLimits({ selectionMaxChars: 20_000 });
    const second = resolveAiContextLimits({ queryResultMaxRows: 40 });
    expect(first).not.toBe(second);
    first.selectionMaxCount = 99;
    first.queryResultBudgetChars = 99;
    expect(second.selectionMaxChars).toBe(AI_CONTEXT_DEFAULTS.selectionMaxChars);
    expect({ ...AI_CONTEXT_DEFAULTS }).toEqual(snapshot);
  });
});
