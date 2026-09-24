import { describe, expect, it } from "vitest";
import { BackendErrorException } from "@/lib/backend/errorUtils";
import { mysqlExplainCompatibilityHint } from "@/lib/diagram/mysqlExplainCompatibility";

const sourceSql = "SELECT * FROM users";
const standardSql = `EXPLAIN FORMAT=TRADITIONAL ${sourceSql}`;
const jsonSql = `EXPLAIN FORMAT=JSON ${sourceSql}`;
const reportedError = "Server error: `ERROR 1105 (HY000): explain format 'JSON' is not supported now` SQL text omitted from user-facing error; enable debug SQL diagnostics to inspect the original statement";
const backendError = new BackendErrorException(reportedError).backendError;

describe("mysqlExplainCompatibilityHint", () => {
  it.each([
    ["string", reportedError],
    ["Error", new Error(reportedError)],
    ["message", { message: reportedError }],
    ["reason", { reason: reportedError }],
    ["detail", { detail: reportedError }],
    ["backend envelope", backendError],
    ["backend exception", new BackendErrorException(backendError)],
    ["nested backendError", { backendError }],
    ["nested error", { error: backendError }],
    ["serialized envelope", JSON.stringify(backendError)],
    ["serialized Error message", new Error(JSON.stringify(backendError))],
  ])("recognizes the reported TiDB JSON rejection as %s", (_label, error) => {
    expect(mysqlExplainCompatibilityHint(error, jsonSql)).toEqual({ supportsJson: false });
  });

  it.each(["explain format 'JSON' is not supported now", 'EXPLAIN FORMAT "json" IS NOT SUPPORTED NOW', "Explain Format `JsOn` Is Not Supported Now", "explain format JSON is not supported now", "explain\tformat\t'json'\tis\tnot\tsupported\tnow"])(
    "recognizes quote, case and whitespace variants: %s",
    (error) => {
      expect(mysqlExplainCompatibilityHint(error, jsonSql)).toEqual({ supportsJson: false });
    },
  );

  it.each([
    "explain format 'TEXT' is not supported now",
    "explain format 'TRADITIONAL' is not supported now",
    "explain format 'TIDB_JSON' is not supported now",
    "explain format 'JSONB' is not supported now",
    "explain format 'JSON\" is not supported now",
    "explain format JSON' is not supported now",
    "explain format 'JSON' is not supported nowhere",
    "ERROR 1105 (HY000): Invalid JSON text",
    "ERROR 1064 (42000): syntax error near 'JSON'",
    "ERROR 1045 (28000): Access denied for JSON EXPLAIN",
    "ERROR 1142 (42000): SELECT command denied during JSON EXPLAIN",
    "Lost connection during EXPLAIN FORMAT=JSON",
    "Query timeout during EXPLAIN FORMAT=JSON",
    "JSON is not supported now",
    "JSON is an invalid explain option",
    "valid options are: [TEXT]",
    "Invalid explain option, valid options are: []",
    "",
    null,
    undefined,
    1105,
    false,
    {},
    { code: 1105 },
  ])("does not classify an unrelated or missing error: %j", (error) => {
    expect(mysqlExplainCompatibilityHint(error, jsonSql)).toBeUndefined();
  });

  it.each([
    ["[TEXT, GRAPHVIZ, DETAIL, SIMPLE]", `EXPLAIN FORMAT=TEXT ${sourceSql}`, false],
    ["['text', \"JSON\", `detail`]", `EXPLAIN FORMAT=TEXT ${sourceSql}`, true],
    ["[ROW, BRIEF]", `EXPLAIN ${sourceSql}`, false],
    ["[JSON]", `EXPLAIN ${sourceSql}`, true],
  ])("preserves the advertised valid-options fallback: %s", (options, fallbackSql, supportsJson) => {
    const error = `TRADITIONAL is an INVALID EXPLAIN option, valid options are: ${options}`;
    expect(mysqlExplainCompatibilityHint(error, standardSql)).toEqual({ fallbackSql, supportsJson });
  });

  it("does not rewrite a default EXPLAIN when valid options include JSON", () => {
    const error = "Invalid explain option, valid options are: [TEXT, JSON]";
    expect(mysqlExplainCompatibilityHint(error, `EXPLAIN ${sourceSql}`)).toEqual({ supportsJson: true });
  });

  it("does not retry an already selected TEXT format", () => {
    const error = "Invalid explain option, valid options are: [TEXT]";
    expect(mysqlExplainCompatibilityHint(error, `EXPLAIN FORMAT=TEXT ${sourceSql}`)).toEqual({ fallbackSql: undefined, supportsJson: false });
  });
});
