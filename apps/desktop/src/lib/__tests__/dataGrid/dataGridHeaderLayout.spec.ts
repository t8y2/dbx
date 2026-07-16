import { describe, expect, it } from "vitest";
import { reserveDataGridHeaderLine } from "@/lib/dataGrid/dataGridHeaderLayout";

describe("reserveDataGridHeaderLine", () => {
  it("reserves a line only when the setting and full-column content require it", () => {
    const values = [{ text: "" }, { text: "later column" }];

    expect(reserveDataGridHeaderLine(false, values, (value) => value.text)).toBe(false);
    expect(reserveDataGridHeaderLine(true, values, (value) => value.text)).toBe(true);
    expect(reserveDataGridHeaderLine(true, [{ text: "" }, { text: "  " }], (value) => value.text)).toBe(false);
    expect(reserveDataGridHeaderLine(true, [], (value: { text: string }) => value.text)).toBe(false);
  });

  it("resolves all columns rather than relying on the currently rendered window", () => {
    const visited: number[] = [];
    const reserved = reserveDataGridHeaderLine(true, ["", "", "comment"], (value, index) => {
      visited.push(index);
      return value;
    });

    expect(reserved).toBe(true);
    expect(visited).toEqual([0, 1, 2]);
  });
});
