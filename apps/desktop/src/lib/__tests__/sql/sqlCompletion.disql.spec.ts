import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems } from "@/lib/sql/sqlCompletion";

describe("DM8 disql keyword completion", () => {
  it.each([
    ["des", "DESCRIBE"],
    ["exe", "EXECUTE"],
    ["pro", "PROMPT"],
    ["sho", "SHOW USER"],
    ["ru", "RUN"],
  ])("offers %s commands", (prefix, label) => {
    const labels = buildSqlCompletionItems(prefix, prefix.length, { databaseType: "dameng", tables: [], columnsByTable: new Map() }).map((item) => item.label);
    expect(labels).toContain(label);
  });
});
