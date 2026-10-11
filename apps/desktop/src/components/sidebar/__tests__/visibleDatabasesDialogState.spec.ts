import { describe, expect, it } from "vitest";
import { resolveVisibleDatabaseSaveAction } from "../visibleDatabasesDialogState";

const allNames = ["data_upload_mid", "ops", "mysql", "performance_schema", "sys"];
const defaultVisibleNames = ["data_upload_mid", "ops"];

function resolve(selection: string[], overrides: Partial<{ configured: string[] | undefined; configuredPatterns: string[]; patterns: string[] }> = {}) {
  return resolveVisibleDatabaseSaveAction({
    selection: new Set(selection),
    allNames,
    defaultVisibleNames,
    configured: "configured" in overrides ? overrides.configured : undefined,
    configuredPatterns: overrides.configuredPatterns,
    patterns: overrides.patterns ?? [],
  });
}

describe("visibleDatabasesDialogState", () => {
  it("treats a full selection as show-all instead of persisting a snapshot list", () => {
    expect(resolve([...defaultVisibleNames])).toEqual({ type: "none" });
    expect(resolve([...defaultVisibleNames], { configured: [...defaultVisibleNames] })).toEqual({ type: "clear" });
  });

  it("persists a real subset as an explicit list", () => {
    expect(resolve(["ops"])).toEqual({ type: "set", databaseNames: ["ops"], patterns: [] });
    expect(resolve(["ops"], { configured: ["ops", "data_upload_mid"] })).toEqual({ type: "set", databaseNames: ["ops"], patterns: [] });
  });

  it("clears an existing subset once the selection grows back to the full default set", () => {
    expect(resolve([...defaultVisibleNames], { configured: ["ops"] })).toEqual({ type: "clear" });
    expect(resolve([...defaultVisibleNames], { configured: ["ops", "mysql"] })).toEqual({ type: "clear" });
  });

  it("keeps an explicit list when system databases are selected on purpose", () => {
    expect(resolve(["data_upload_mid", "ops", "mysql"])).toEqual({ type: "set", databaseNames: ["data_upload_mid", "ops", "mysql"], patterns: [] });
  });

  it("keeps the list while wildcard patterns are active because the two are unioned", () => {
    expect(resolve([...defaultVisibleNames], { patterns: ["log_%"] })).toEqual({
      type: "set",
      databaseNames: [...defaultVisibleNames],
      patterns: ["log_%"],
    });
  });

  it("skips persistence when nothing changed", () => {
    expect(resolve(["ops"], { configured: ["ops"] })).toEqual({ type: "none" });
    expect(resolve(["ops"], { configured: ["ops"], configuredPatterns: ["log_%"], patterns: ["log_%"] })).toEqual({ type: "none" });
  });

  it("writes a changed wildcard filter back", () => {
    expect(resolve(["ops"], { configured: ["ops"], configuredPatterns: ["log_%"], patterns: ["tmp_%"] })).toEqual({
      type: "set",
      databaseNames: ["ops"],
      patterns: ["tmp_%"],
    });
    expect(resolve([...defaultVisibleNames], { configuredPatterns: ["log_%"], patterns: [] })).toEqual({ type: "clear" });
  });

  it("drops names that no longer exist and ignores blank wildcards", () => {
    expect(resolve(["ops", "dropped_db"])).toEqual({ type: "set", databaseNames: ["ops"], patterns: [] });
    expect(resolve([...defaultVisibleNames], { patterns: ["", "  "] })).toEqual({ type: "none" });
  });
});
