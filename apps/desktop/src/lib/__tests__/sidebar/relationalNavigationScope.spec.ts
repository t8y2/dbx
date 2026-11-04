import { describe, expect, it } from "vitest";
import { parseRelationalNavigationSelections, relationalNavigationContainerKey, resolveRelationalNavigationSelection } from "@/lib/sidebar/relationalNavigationScope";

describe("relational navigation scope", () => {
  it("keeps a saved choice through cached, partial and failed discovery", () => {
    expect(resolveRelationalNavigationSelection({ saved: { kind: "named", name: "B" }, defaultName: "A", availableNames: ["A"], discoveryComplete: false })).toEqual({ kind: "named", name: "B" });
  });
  it("falls back only after complete discovery confirms absence", () => {
    expect(resolveRelationalNavigationSelection({ saved: { kind: "named", name: "B" }, defaultName: "A", availableNames: ["A"], discoveryComplete: true })).toEqual({ kind: "named", name: "A" });
    expect(resolveRelationalNavigationSelection({ saved: { kind: "named", name: "B" }, defaultName: "C", availableNames: ["A"], discoveryComplete: true })).toEqual({ kind: "all" });
  });
  it("prefers saved all and never chooses the first discovered schema", () => {
    expect(resolveRelationalNavigationSelection({ saved: { kind: "all" }, defaultName: "A", availableNames: ["A"], discoveryComplete: true })).toEqual({ kind: "all" });
    expect(resolveRelationalNavigationSelection({ availableNames: ["A", "B"], discoveryComplete: true })).toEqual({ kind: "all" });
  });
  it("preserves exact names including a real empty default schema", () => {
    expect(resolveRelationalNavigationSelection({ defaultName: "", availableNames: [""], discoveryComplete: true })).toEqual({ kind: "named", name: "" });
    expect(resolveRelationalNavigationSelection({ saved: { kind: "named", name: "a" }, availableNames: ["A"], discoveryComplete: true })).toEqual({ kind: "all" });
  });
  it("isolates catalogs, databases, linked servers and scope kinds without delimiter collisions", () => {
    const container = { connectionId: "c", kind: "schema" as const, database: "db", catalog: "A", linkedServer: "remote" };
    const keys = [container, { ...container, catalog: "B" }, { ...container, database: "other" }, { ...container, linkedServer: "local" }, { ...container, kind: "database" as const }].map(relationalNavigationContainerKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(relationalNavigationContainerKey({ connectionId: "a:b", kind: "schema", database: "c" })).not.toBe(relationalNavigationContainerKey({ connectionId: "a", kind: "schema", database: "b:c" }));
  });
  it("restores only valid preferences and tolerates unavailable or malformed storage", () => {
    expect(parseRelationalNavigationSelections(null)).toEqual({});
    expect(parseRelationalNavigationSelections("{")).toEqual({});
    expect(parseRelationalNavigationSelections("[]")).toEqual({});
    expect(parseRelationalNavigationSelections(JSON.stringify({ a: { kind: "all" }, b: { kind: "named", name: "B" }, c: { kind: "named" }, d: null }))).toEqual({ a: { kind: "all" }, b: { kind: "named", name: "B" } });
  });
});
