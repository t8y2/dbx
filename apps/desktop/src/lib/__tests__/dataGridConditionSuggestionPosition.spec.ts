import { describe, expect, test } from "vitest";

import { getDataGridConditionSuggestionPosition } from "@/lib/dataGridConditionSuggestionPosition";

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
});
