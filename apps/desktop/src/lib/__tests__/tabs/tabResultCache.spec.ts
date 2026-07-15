import { describe, expect, it } from "vitest";
import { decodeTabResultSnapshot, encodeTabResultSnapshot } from "@/lib/tabs/tabResultCache";

describe("tab result cache statement execution metadata", () => {
  it("preserves statement identity and the editor fingerprint", () => {
    const encoded = encodeTabResultSnapshot({
      results: [
        {
          columns: ["value"],
          rows: [[1]],
          affected_rows: 0,
          execution_time_ms: 1,
          statement_index: 0,
          sourceStatement: "SELECT 1",
        },
        {
          columns: ["Error"],
          rows: [["failed"]],
          affected_rows: 0,
          execution_time_ms: 1,
          execution_error: true,
          statement_index: 1,
          sourceStatement: "SELECT bad",
        },
      ],
      resultEditorFingerprint: "15:0123456789abcdef",
      cachedAt: 1,
    });

    const restored = decodeTabResultSnapshot(encoded);

    expect(restored?.resultEditorFingerprint).toBe("15:0123456789abcdef");
    expect(restored?.results?.map((result) => ({ statementIndex: result.statement_index, error: result.execution_error }))).toEqual([
      { statementIndex: 0, error: undefined },
      { statementIndex: 1, error: true },
    ]);
  });
});
