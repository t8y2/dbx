import { describe, expect, it } from "vitest";
import { localizeMongoScriptError, localizeMongoScriptMessages, mongoScriptErrorReportsProgress } from "@/lib/mongo/mongoScriptErrors";

const t = (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ""}`;

describe("MongoDB script errors", () => {
  it("detects reported progress", () => {
    expect(mongoScriptErrorReportsProgress("Query canceled\nConfirmed completed operations: 1 (0 writes).")).toBe(true);
    expect(mongoScriptErrorReportsProgress("boom\nOutcome unknown, it may or may not have been applied: db.a.insertOne({})")).toBe(true);
    expect(mongoScriptErrorReportsProgress("Query canceled")).toBe(false);
  });

  it("localizes only the progress lines", () => {
    const message = ["E11000 duplicate key error", "    at load (script:2:10)", "Confirmed completed operations: 3 (2 writes).", "Outcome unknown, it may or may not have been applied: db.a.insertOne({ a: 1 })", "Writes are not rolled back.", "MongoDB script timed out after 800 ms."].join("\n");
    expect(localizeMongoScriptError(message, t).split("\n")).toEqual([
      "E11000 duplicate key error",
      "    at load (script:2:10)",
      'mongoScript.progressConfirmed{"count":3,"writes":2}',
      'mongoScript.progressUnknown{"operation":"db.a.insertOne({ a: 1 })"}',
      "mongoScript.progressNotRolledBack",
      'mongoScript.timedOut{"ms":800}',
    ]);
  });

  it("localizes the messages of a successful script by their code", () => {
    const messages = [
      { severity: "INFO", code: "MONGO_SCRIPT_WRITES", message: "Confirmed completed operations: 4 (3 writes)." },
      { severity: "WARNING", code: "MONGO_SCRIPT_UNKNOWN_WRITE", message: 'A failed write was caught by the script; its outcome is unknown: db.getCollection("a").insertOne({})' },
      { severity: "WARNING", code: "MONGO_SCRIPT_UNKNOWN_WRITES_DROPPED", message: "5 more failed writes were caught by the script; their outcome is unknown." },
      { severity: "NOTICE", code: "OTHER", message: "Confirmed completed operations: 1 (1 writes)." },
    ];
    expect(localizeMongoScriptMessages(messages, t)?.map((entry) => entry.message)).toEqual([
      'mongoScript.progressConfirmed{"count":4,"writes":3}',
      'mongoScript.messageUnknownWrite{"operation":"db.getCollection(\\"a\\").insertOne({})"}',
      'mongoScript.messageUnknownWritesDropped{"count":5}',
      "Confirmed completed operations: 1 (1 writes).",
    ]);
    expect(localizeMongoScriptMessages(undefined, t)).toBeUndefined();
  });
});
