import { describe, expect, it } from "vitest";
import { mergeQueryMessages } from "../../apps/desktop/src/lib/query/queryResultMessages";
import type { QueryMessage } from "../../apps/desktop/src/types/database";
import { hasQueryOutput } from "../../apps/desktop/src/lib/query/queryOutput";

const notice: QueryMessage = { severity: "NOTICE", message: "same", code: "00000" };

describe("streamed query messages", () => {
  it("does not duplicate streamed messages in the completed response", () => {
    expect(mergeQueryMessages([notice, notice], [notice, notice])).toEqual([notice, notice]);
  });

  it("preserves repeated occurrences and messages from other drivers", () => {
    const warning = { severity: "WARNING", message: "other" };
    expect(mergeQueryMessages([notice], [notice, notice, warning])).toEqual([notice, notice, warning]);
  });

  it("retains messages when execution returns no successful result", () => {
    expect(mergeQueryMessages([notice], [])).toEqual([notice]);
    expect(hasQueryOutput({ liveQueryMessages: [notice] })).toBe(true);
  });

  it("normalizes optional fields while keeping different details distinct", () => {
    const detailed = { ...notice, detail: "context" };
    expect(mergeQueryMessages([notice], [{ ...notice, hint: undefined }, detailed])).toEqual([notice, detailed]);
  });
});
