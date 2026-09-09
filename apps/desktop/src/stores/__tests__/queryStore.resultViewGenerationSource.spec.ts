import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryStoreSource = readFileSync(new URL("../queryStore.ts", import.meta.url), "utf8");

/** Every direct assignment to the token, as `file:line`-ish snippets. */
function directAssignments(): string[] {
  return queryStoreSource
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter((entry) => /^(current|tab|run)\.resultViewGeneration\s*=/.test(entry.line))
    .map((entry) => `${entry.number}: ${entry.line}`);
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
    expect(queryStoreSource).toContain('publishResultGeneration(current, shouldAppendResult ? "append" : (options?.publicationOrigin ?? "execute"));');
    expect(queryStoreSource).toContain('publishResultGeneration(tab, "local-sort");');
    expect(queryStoreSource).toContain('publishResultGeneration(tab, "execute");');
  });

  it("keeps the evicted result snapshot instead of clearing it", () => {
    expect(queryStoreSource).toContain("if (!options.evicted) {");
    expect(queryStoreSource).toContain("beginClosingDataGridViewSnapshotsForTab(tab.id);");
  });
});
