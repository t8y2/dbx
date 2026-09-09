import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryStoreSource = readFileSync(new URL("../queryStore.ts", import.meta.url), "utf8");

/** Every direct assignment to the token, with its line number. */
function directAssignments(): string[] {
  return queryStoreSource
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter((entry) => /^(current|tab|run)\.resultViewGeneration\s*=/.test(entry.line))
    .map((entry) => `${entry.number}: ${entry.line}`);
}

/** The body of executeTabSql, where every result publication must live. */
function executeTabSqlBody(): string {
  const start = queryStoreSource.indexOf("async function executeTabSql(");
  const end = queryStoreSource.indexOf("\n  }\n", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return queryStoreSource.slice(start, end);
}

describe("queryStore resultViewGeneration writer", () => {
  it("assigns the token in exactly the allowed places", () => {
    const assignments = directAssignments();

    // publishResultGeneration (the writer) plus the two identity-preserving
    // readers: disk restore inherits, run projection copies the run's value.
    expect(assignments).toHaveLength(3);
    expect(assignments.join("\n")).toContain("snapshot.resultViewGeneration");
    expect(assignments.join("\n")).toContain("run.resultViewGeneration");
  });

  it("defaults an unclassified publication to a new generation", () => {
    const start = queryStoreSource.indexOf("function publishResultGeneration(");
    const end = queryStoreSource.indexOf("function ", start + 10);
    const body = queryStoreSource.slice(start, end);

    expect(body).toContain('if (origin === "disk-restore") return;');
    expect(body).toContain('if (origin === "append") {');
    expect(body).toContain("tab.resultViewGeneration = uuid();");
  });

  it("publishes a generation for every replacement branch of executeTabSql", () => {
    const body = executeTabSqlBody();

    // Generic branch: append inherits, everything else replaces.
    expect(body).toContain('publishResultGeneration(current, shouldAppendResult ? "append" : (options?.publicationOrigin ?? "execute"));');
    // Redis, MongoDB, and Elasticsearch branches replace the visible result too;
    // Mongo's append variant must keep the current generation.
    expect(body).toContain('publishResultGeneration(current, shouldAppendResult ? "append" : "execute");');
    const publicationCount = body.match(/publishResultGeneration\(current/g)?.length ?? 0;
    expect(publicationCount).toBeGreaterThanOrEqual(5);
  });

  it("publishes outside executeTabSql where results are also replaced", () => {
    expect(queryStoreSource).toContain('publishResultGeneration(tab, "local-sort");');
    expect(queryStoreSource).toContain('publishResultGeneration(tab, "execute");');
    expect(queryStoreSource).toContain('publishResultGeneration(current, "execute");');
  });

  it("reserves the closing tombstone for tab closure, not ordinary execution", () => {
    // Ordinary execution clears the payload before running; the tombstone there
    // would block capturing the fresh result's view for five seconds.
    const clearResultPayloadStart = queryStoreSource.indexOf("function clearResultPayload(");
    const clearResultPayloadEnd = queryStoreSource.indexOf("\n  }\n", clearResultPayloadStart);
    const clearResultPayloadBody = queryStoreSource.slice(clearResultPayloadStart, clearResultPayloadEnd);
    expect(clearResultPayloadBody).not.toContain("beginClosingDataGridViewSnapshotsForTab");
    expect(clearResultPayloadBody).toContain("clearDataGridViewSnapshotsForTab(tab.id);");
    // Tab closure keeps the tombstone so the teardown capture cannot resurrect.
    expect(queryStoreSource).toContain("beginClosingDataGridViewSnapshotsForTab(id);");
    expect(queryStoreSource.match(/beginClosingDataGridViewSnapshotsForTab\(tab\.id\)/g)?.length).toBe(2);
  });
});
