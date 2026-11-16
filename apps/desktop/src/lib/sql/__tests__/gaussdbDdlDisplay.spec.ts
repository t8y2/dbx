import { describe, expect, it } from "vitest";
import { formatDdlForDisplay } from "@/lib/sql/ddlDisplay";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { SqlFormatterSettings } from "@/lib/sql/sqlFormatterConfig";

// Original pg_get_tabledef text and formatter configuration from issue #14338.
const ddl = `SET search_path = yt;
CREATE TABLE test_table (
    a character varying(20),
    b character varying(20),
    c character varying(20),
    d character varying(20),
    e character varying(20),
    f character varying(20),
    g character varying(20),
    h character varying(20),
    i character varying(20),
    j character varying(20)
)
WITH (orientation=row, compression=no);
COMMENT ON TABLE test_table IS '测试表';
COMMENT ON COLUMN test_table.a IS '测试字段';
COMMENT ON COLUMN test_table.b IS '测试字段';
COMMENT ON COLUMN test_table.c IS '测试字段';
COMMENT ON COLUMN test_table.d IS '测试字段';
COMMENT ON COLUMN test_table.e IS '测试字段';
COMMENT ON COLUMN test_table.f IS '测试字段';
COMMENT ON COLUMN test_table.g IS '测试字段';
COMMENT ON COLUMN test_table.h IS '客户类别(01-个人,02-企业,03-金融,04-客户群)';
COMMENT ON COLUMN test_table.i IS '测试字段';
COMMENT ON COLUMN test_table.j IS '测试字段';`;
const formatter: Partial<SqlFormatterSettings> = {
  customRulesEnabled: true,
  listLayout: "fit",
  selectListLayout: "vertical",
  insertListLayout: "fit",
  updateListLayout: "fit",
  listItemAlignment: "firstItem",
  alignSelectAliases: true,
  alignUpdateAssignments: false,
  selectCommaPosition: "inherit",
  insertCommaPosition: "inherit",
  updateCommaPosition: "inherit",
  whereLogicalOperatorNewline: "inherit",
  onLogicalOperatorNewline: "inherit",
  expressionLogicalOperatorNewline: "inherit",
  newlineBeforeJoinOn: true,
  collapseShortStatements: true,
  emptyLineMode: "inherit",
  layoutStyle: "dbx",
  keywordCase: "upper",
  dataTypeCase: "preserve",
  functionCase: "preserve",
  identifierCase: "preserve",
  indentStyle: "standard",
  useTabs: false,
  tabWidth: 2,
  logicalOperatorNewline: "before",
  commaPosition: "after",
  fromClauseLayout: "sameLine",
  expressionWidth: 50,
  linesBetweenQueries: 1,
  preserveEmptyLines: false,
  denseOperators: false,
  newlineBeforeSemicolon: false,
  paramTypes: null,
};

describe("GaussDB DDL display #14338", () => {
  it.each([true, false])("preserves COMMENT ON COLUMN separation with identifier quotes=%s", async (quoteIdentifiers) => {
    const options = { dialect: "postgres", databaseType: "gaussdb", includeDatabaseName: false, quoteIdentifiers } as const;
    const result = await formatDdlForDisplay(ddl, options, formatter);
    expect(result).toContain("COMMENT ON COLUMN test_table.h IS '客户类别(01-个人,02-企业,03-金融,04-客户群)';");
    expect(tokenizeSqlSemantic(result, "postgres").map((token) => token.normalized)).toEqual(tokenizeSqlSemantic(ddl, "postgres").map((token) => token.normalized));
    expect(await formatDdlForDisplay(result, options, formatter)).toBe(result);
  });
});
