import { describe, expect, test } from "vitest";

import { getDataGridConditionSuggestionPosition, getDataGridConditionSuggestionPreferredWidth } from "@/lib/dataGrid/dataGridConditionSuggestionPosition";

describe("getDataGridConditionSuggestionPosition", () => {
  test("anchors the dropdown to the input instead of the caret", () => {
    const position = getDataGridConditionSuggestionPosition({ left: 120, bottom: 40, width: 420 }, { viewportWidth: 1000 });

    expect(position).toEqual({ left: 120, top: 42, width: 420 });
  });

  test("keeps long history rows inside the viewport", () => {
    const position = getDataGridConditionSuggestionPosition({ left: 780, bottom: 40, width: 420 }, { viewportWidth: 1000 });

    expect(position.left + position.width).toBeLessThanOrEqual(992);
    expect(position.width).toBe(420);
  });

  test("uses a minimum width for narrow inputs", () => {
    const position = getDataGridConditionSuggestionPosition({ left: 20, bottom: 40, width: 120 }, { viewportWidth: 1000 });

    expect(position.width).toBe(180);
  });

  test("widens commented field suggestions within the configured maximum", () => {
    const preferredWidth = getDataGridConditionSuggestionPreferredWidth([
      { value: "customer_external_identifier", kind: "column", comment: "客户外部系统唯一标识" },
      { value: "customer_name", kind: "column", comment: "客户名称" },
    ]);
    const position = getDataGridConditionSuggestionPosition({ left: 120, bottom: 40, width: 220 }, { viewportWidth: 1000, preferredWidth, maxWidth: 520 });

    expect(preferredWidth).toBeGreaterThan(220);
    expect(position.width).toBe(preferredWidth);
    expect(position.width).toBeLessThanOrEqual(520);
  });

  test("keeps normal width when suggestions have no comments or are history entries", () => {
    expect(
      getDataGridConditionSuggestionPreferredWidth([
        { value: "customer_id", kind: "column", comment: "" },
        { value: "status = 'active'", kind: "history" },
      ]),
    ).toBeUndefined();

    const position = getDataGridConditionSuggestionPosition({ left: 120, bottom: 40, width: 220 }, { viewportWidth: 1000, preferredWidth: undefined, maxWidth: 520 });
    expect(position.width).toBe(220);
  });

  test("caps commented suggestions to both the maximum and the viewport", () => {
    const position = getDataGridConditionSuggestionPosition({ left: 760, bottom: 40, width: 180 }, { viewportWidth: 420, preferredWidth: 800, maxWidth: 520 });

    expect(position.width).toBe(404);
    expect(position.left + position.width).toBeLessThanOrEqual(412);
  });
});
