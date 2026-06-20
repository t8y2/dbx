import { describe, expect, it } from "vitest";
import { formatSelectionAsTsv } from "@/lib/gridSelection";

describe("gridSelection", () => {
  it("formats TSV selections without headers by default", () => {
    expect(
      formatSelectionAsTsv({
        columns: ["id", "name"],
        rows: [
          [1, "Ada"],
          [2, "Lin"],
        ],
      }),
    ).toBe("1\tAda\n2\tLin");
  });

  it("can include column headers in TSV selections", () => {
    expect(
      formatSelectionAsTsv(
        {
          columns: ["id", "name"],
          rows: [
            [1, "Ada"],
            [2, "Lin"],
          ],
        },
        true,
      ),
    ).toBe("id\tname\n1\tAda\n2\tLin");
  });
});
