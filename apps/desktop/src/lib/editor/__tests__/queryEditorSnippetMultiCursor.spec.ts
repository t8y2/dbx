import { describe, expect, it } from "vitest";
import { expandSnippetTemplate, snippetReplacementSpans } from "@/lib/editor/queryEditorSnippetMultiCursor";

describe("expandSnippetTemplate", () => {
  it("fills numbered fields with their default value", () => {
    expect(expandSnippetTemplate("select * from ${1:table_name};")).toBe("select * from table_name;");
  });

  it("collapses ${0} and named fields", () => {
    expect(expandSnippetTemplate("a${0}b${name}c")).toBe("abc");
  });

  it("keeps plain text and nested defaults", () => {
    expect(expandSnippetTemplate("INSERT INTO t (${1:col}) VALUES (${2:value});")).toBe("INSERT INTO t (col) VALUES (value);");
  });
});

describe("snippetReplacementSpans", () => {
  const docText = "sfhd_dwd.dwd_t_ug_org\nsfhd_dwd.dwd_t_ug_user\nsfhd_dwd.dwd_t_cus_room";
  // "sfhd_dwd.dwd_t_ug_org" = 21 chars; "sfhd_dwd.dwd_t_ug_user" = 22 chars
  const lineStarts = [0, 22, 45];
  const lineFrom = (pos: number) => {
    for (let i = lineStarts.length - 1; i >= 0; i--) {
      if (pos >= lineStarts[i]) return lineStarts[i];
    }
    return 0;
  };
  const sliceDoc = (from: number, to: number) => docText.slice(from, to);

  it("reuses the completion span for the cursor at replaceTo", () => {
    const spans = snippetReplacementSpans([2, 24, 47], 2, 0, 2, lineFrom, sliceDoc);
    expect(spans).toEqual([
      { from: 0, to: 2 },
      { from: 22, to: 24 },
      { from: 45, to: 47 },
    ]);
  });

  it("matches the identifier token before each cursor", () => {
    const spans = snippetReplacementSpans([2, 24, 47], 2, 0, 2, lineFrom, sliceDoc);
    expect(spans.map((s) => docText.slice(s.from, s.to))).toEqual(["sf", "sf", "sf"]);
  });

  it("falls back to a plain insertion when no token precedes the cursor", () => {
    // cursor at line start (head == lineFrom) has no preceding token
    const spans = snippetReplacementSpans([22], 2, 0, 2, lineFrom, sliceDoc);
    expect(spans).toEqual([{ from: 22, to: 22 }]);
  });
});
