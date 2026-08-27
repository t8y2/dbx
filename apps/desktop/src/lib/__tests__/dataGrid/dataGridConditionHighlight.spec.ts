import { describe, expect, it } from "vitest";
import { tokenizeDataGridCondition, type DataGridConditionToken } from "@/lib/dataGrid/dataGridConditionHighlight";

function pairs(text: string): string[] {
  return tokenizeDataGridCondition(text).map((token) => `${token.type}:${token.text}`);
}

describe("tokenizeDataGridCondition", () => {
  it("colors keywords, fields and values in a where condition", () => {
    expect(pairs("name = 'dbx' and age >= 18")).toEqual(["field:name", "plain: = ", "value:'dbx'", "plain: ", "keyword:and", "plain: ", "field:age", "plain: >= ", "value:18"]);
  });

  it("matches keywords case-insensitively", () => {
    expect(pairs("a AND b OR c")).toEqual(["field:a", "plain: ", "keyword:AND", "plain: ", "field:b", "plain: ", "keyword:OR", "plain: ", "field:c"]);
  });

  it("treats in/is/null/between/like as keywords", () => {
    expect(pairs("id in (1, 2) and deleted_at is not null")).toEqual(["field:id", "plain: ", "keyword:in", "plain: (", "value:1", "plain:, ", "value:2", "plain:) ", "keyword:and", "plain: ", "field:deleted_at", "plain: ", "keyword:is", "plain: ", "keyword:not", "plain: ", "keyword:null"]);
  });

  it("colors asc/desc in order by", () => {
    expect(pairs("created_at desc, id asc")).toEqual(["field:created_at", "plain: ", "keyword:desc", "plain:, ", "field:id", "plain: ", "keyword:asc"]);
  });

  it("keeps quoted identifiers as fields", () => {
    expect(pairs("`order` = 1 and [user name] = 'x'")).toEqual(["field:`order`", "plain: = ", "value:1", "plain: ", "keyword:and", "plain: ", "field:[user name]", "plain: = ", "value:'x'"]);
  });

  it("keeps escaped quotes inside string values", () => {
    expect(pairs("name = 'it''s'")).toEqual(["field:name", "plain: = ", "value:'it''s'"]);
  });

  it("treats double-quoted runs as values", () => {
    expect(pairs('name = "abc"')).toEqual(["field:name", "plain: = ", 'value:"abc"']);
  });

  it("reads decimal and exponent numbers as values", () => {
    expect(pairs("score > 0.5 and ratio <= 1e-3")).toEqual(["field:score", "plain: > ", "value:0.5", "plain: ", "keyword:and", "plain: ", "field:ratio", "plain: <= ", "value:1e-3"]);
  });

  it("keeps dotted and unicode names as fields", () => {
    expect(pairs("t.名称 = 'v'")).toEqual(["field:t.名称", "plain: = ", "value:'v'"]);
  });

  it("does not treat keyword-looking prefixes as keywords", () => {
    expect(pairs("android = 1")).toEqual(["field:android", "plain: = ", "value:1"]);
  });

  it("returns an empty list for empty input", () => {
    expect(tokenizeDataGridCondition("")).toEqual([]);
  });

  it("preserves the full text across tokens", () => {
    const text = "name = 'dbx' and (age >= 18 or city like 'sh%') order by id desc";
    const joined = tokenizeDataGridCondition(text)
      .map((token: DataGridConditionToken) => token.text)
      .join("");
    expect(joined).toBe(text);
  });
});
