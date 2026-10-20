import { describe, expect, it } from "vitest";
import { resolveVisibleDatabaseSaveAction, visibleDatabasePatternsWithoutMatchAll } from "../visibleDatabasesDialogState";

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

  it("persists a match-all wildcard when every database, including system ones, is selected", () => {
    // “显示系统库”后全选：不能存库名快照（新增库会丢失），也不能按未筛选保存
    // （默认视图又会隐藏系统库），用全匹配通配符保持动态的全量可见。
    expect(resolve([...allNames])).toEqual({ type: "set", databaseNames: undefined, patterns: ["%"] });
    expect(resolve([...allNames], { configuredPatterns: ["%"] })).toEqual({ type: "none" });
    expect(resolve([...allNames], { configured: [...allNames] })).toEqual({ type: "set", databaseNames: undefined, patterns: ["%"] });
  });

  it("drops the internal match-all wildcard before resolving the user's patterns", () => {
    expect(visibleDatabasePatternsWithoutMatchAll(["%", "log_%"])).toEqual(["log_%"]);
    expect(visibleDatabasePatternsWithoutMatchAll(undefined)).toEqual([]);
  });

  it("keeps clearing when all names are already the default visible set", () => {
    expect(
      resolveVisibleDatabaseSaveAction({
        selection: new Set(["data_upload_mid", "ops"]),
        allNames: ["data_upload_mid", "ops"],
        defaultVisibleNames: ["data_upload_mid", "ops"],
        configured: ["data_upload_mid", "ops"],
        configuredPatterns: undefined,
        patterns: [],
      }),
    ).toEqual({ type: "clear" });
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
