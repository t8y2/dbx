import { describe, expect, it } from "vitest";
import { clampMongoScriptMaxRows, MAX_MONGO_SCRIPT_ROWS, mongoScriptResultToQueryResult, translateMongoScriptError, type MongoScriptResultLabels } from "@/lib/mongo/mongoScript";

const labels: MongoScriptResultLabels = {
  typeColumn: "Output",
  valueColumn: "Value",
  textOutput: "Text",
  jsonOutput: "JSON",
  finalValue: "Final value",
  summary: "Summary",
  summaryValue: ({ succeeded, attempted, database }) => `${succeeded}/${attempted} @ ${database}`,
  outputTruncated: "Truncated",
};

describe("MongoDB JavaScript editor integration", () => {
  it("maps bounded output, nested final values, summary, and truncation into one result", () => {
    const result = mongoScriptResultToQueryResult(
      {
        output: [
          { kind: "text", value: "started" },
          { kind: "json", value: { nested: [1, 2] } },
        ],
        finalValue: { ok: true },
        operationCount: 3,
        succeededOperationCount: 2,
        currentDatabase: "analytics",
        truncated: true,
      },
      12,
      labels,
    );

    expect(result).toMatchObject({
      columns: ["Output", "Value"],
      column_types: ["TEXT", "TEXT"],
      affected_rows: 0,
      execution_time_ms: 12,
      truncated: false,
      has_more: false,
    });
    expect(result.rows).toEqual([
      ["Text", "started"],
      ["JSON", '{\n  "nested": [\n    1,\n    2\n  ]\n}'],
      ["Final value", '{\n  "ok": true\n}'],
      ["Summary", "2/3 @ analytics"],
      ["Summary", "Truncated"],
    ]);
  });

  it("clamps client-provided row limits to the MongoDB script safety cap", () => {
    expect(clampMongoScriptMaxRows(250)).toBe(250);
    expect(clampMongoScriptMaxRows(Number.MAX_SAFE_INTEGER)).toBe(MAX_MONGO_SCRIPT_ROWS);
    expect(clampMongoScriptMaxRows(Number.POSITIVE_INFINITY)).toBe(MAX_MONGO_SCRIPT_ROWS);
    expect(clampMongoScriptMaxRows(0)).toBe(1);
  });

  it("localizes typed errors while preserving details and partial progress", () => {
    const t = (key: string, params?: Record<string, unknown>) => (params ? `${key}:${params.succeeded}/${params.attempted}` : key);

    expect(translateMongoScriptError(t, "[mongo_script.timeout] MongoDB shell execution timed out")).toBe("mongoScript.errorTimeout\n\nMongoDB shell execution timed out");
    expect(translateMongoScriptError(t, new Error("[mongo_script.host] duplicate key (MongoDB shell progress: 2 confirmed completed of 3 attempted operations)"))).toBe("mongoScript.errorHost\n\nduplicate key\n\nmongoScript.errorPartialCompletion:2/3");
    expect(translateMongoScriptError(t, new Error("[mongo_script.host] duplicate key (MongoDB shell stopped after 2 of 3 attempted operations succeeded)"))).toBe("mongoScript.errorHost\n\nduplicate key\n\nmongoScript.errorPartialCompletion:2/3");
    expect(translateMongoScriptError(t, "[mongo_script.cancelled] MongoDB shell execution was cancelled (MongoDB shell progress: 1 confirmed completed of 2 attempted operations; in-flight operation outcome unknown)")).toBe(
      "mongoScript.errorCancelled\n\nMongoDB shell execution was cancelled\n\nmongoScript.errorPartialCompletion:1/2\n\nmongoScript.errorUnknownOutcome",
    );
    expect(translateMongoScriptError(t, "[mongo_script.runtime] Unsupported MongoDB collection method: bulkWrite")).toBe("mongoScript.errorUnsupportedApi\n\nUnsupported MongoDB collection method: bulkWrite");
    expect(translateMongoScriptError(t, "[mongo_script.runtime] TypeError: Unsupported MongoDB database method: watch")).toBe("mongoScript.errorUnsupportedApi\n\nTypeError: Unsupported MongoDB database method: watch");
    expect(
      translateMongoScriptError(t, {
        backendError: {
          version: 1,
          code: "DBX-LEGACY-0001",
          messageKey: "backendErrors.legacy",
          messageParams: {},
          source: "legacyBackend",
          operationOutcome: "unknown",
          detail: "[mongo_script.cancelled] MongoDB shell execution was cancelled",
        },
      }),
    ).toBe("mongoScript.errorCancelled\n\nMongoDB shell execution was cancelled");
    expect(translateMongoScriptError(t, "ordinary failure")).toBeNull();
  });
});
