import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS } from "@/lib/editor/shortcutRegistry";
import { buildSelectStarWithLimitSql } from "@/lib/sql/sqlDialectSelectLimit";
import { buildSqlShortcutExecutionSql, enabledSqlShortcutActions, findSqlShortcutConflicts, hasSqlShortcutConflicts, resolveSqlShortcutForDatabase, resolveSqlShortcutTemplate, sqlShortcutAppliesToDatabase, uniqueSqlShortcutBindings } from "@/lib/sql/sqlShortcutActions";
import type { SqlShortcutAction } from "@/types/database";

function action(id: string, shortcut: string, overrides: Partial<SqlShortcutAction> = {}): SqlShortcutAction {
  return {
    id,
    label: id,
    shortcut,
    sql: "SELECT * FROM ${table}",
    enabled: true,
    ...overrides,
  };
}

describe("resolveSqlShortcutTemplate", () => {
  it("replaces ${table} with trimmed selection", () => {
    expect(resolveSqlShortcutTemplate("SELECT * FROM ${table}", " orders ")).toBe("SELECT * FROM orders");
  });

  it("replaces all occurrences", () => {
    expect(resolveSqlShortcutTemplate("SELECT * FROM ${table} JOIN ${table}", "public.users")).toBe("SELECT * FROM public.users JOIN public.users");
  });

  it("does not expand replacement patterns in the selection", () => {
    expect(resolveSqlShortcutTemplate("SELECT * FROM ${table}", "a$&b")).toBe("SELECT * FROM a$&b");
    expect(resolveSqlShortcutTemplate("SELECT * FROM ${table}", "x$'y")).toBe("SELECT * FROM x$'y");
    expect(resolveSqlShortcutTemplate("${table} ${table}", "$`1")).toBe("$`1 $`1");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("enabledSqlShortcutActions", () => {
  it("filters disabled and unbound actions", () => {
    const actions = [action("a", "Mod+1"), action("b", "", { enabled: true }), action("c", "Mod+2", { enabled: false })];
    expect(enabledSqlShortcutActions(actions).map((item) => item.id)).toEqual(["a"]);
  });
});

describe("findSqlShortcutConflicts", () => {
  it("detects duplicate custom shortcuts", () => {
    const actions = [action("a", "Mod+Shift+1"), action("b", "Mod+Shift+1")];
    expect(findSqlShortcutConflicts(actions, DEFAULT_SHORTCUT_SETTINGS)).toEqual(expect.arrayContaining(["a", "b"]));
    expect(hasSqlShortcutConflicts(actions, DEFAULT_SHORTCUT_SETTINGS)).toBe(true);
  });

  it("allows the same shortcut across non-overlapping database types", () => {
    const actions = [action("mysql", "Mod+Shift+1", { databaseTypes: ["mysql"] }), action("sqlserver", "Mod+Shift+1", { databaseTypes: ["sqlserver"] })];
    expect(findSqlShortcutConflicts(actions, DEFAULT_SHORTCUT_SETTINGS)).toEqual([]);
  });

  it("detects conflicts when database type scopes overlap", () => {
    const actions = [action("a", "Mod+Shift+1", { databaseTypes: ["mysql", "postgres"] }), action("b", "Mod+Shift+1", { databaseTypes: ["postgres"] })];
    expect(findSqlShortcutConflicts(actions, DEFAULT_SHORTCUT_SETTINGS)).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("treats all-databases scope as overlapping any scoped action", () => {
    const actions = [action("all", "Mod+Shift+1"), action("mysql", "Mod+Shift+1", { databaseTypes: ["mysql"] })];
    expect(findSqlShortcutConflicts(actions, DEFAULT_SHORTCUT_SETTINGS)).toEqual(expect.arrayContaining(["all", "mysql"]));
  });

  it("detects duplicate custom shortcuts with different modifier order", () => {
    const actions = [action("a", "Mod+Shift+1"), action("b", "Shift+Mod+1")];
    expect(findSqlShortcutConflicts(actions, DEFAULT_SHORTCUT_SETTINGS)).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("detects conflicts with fixed editor shortcuts", () => {
    const actions = [action("a", DEFAULT_SHORTCUT_SETTINGS.formatSql)];
    expect(findSqlShortcutConflicts(actions, DEFAULT_SHORTCUT_SETTINGS)).toEqual(["a"]);
  });

  it("ignores disabled actions", () => {
    const actions = [action("a", "Mod+Shift+1", { enabled: false }), action("b", "Mod+Shift+1")];
    expect(findSqlShortcutConflicts(actions, DEFAULT_SHORTCUT_SETTINGS)).toEqual([]);
  });
});

describe("resolveSqlShortcutForDatabase", () => {
  it("prefers a scoped action over an all-databases action", () => {
    const actions = [action("all", "Mod+Shift+1", { sql: "ALL" }), action("mysql", "Mod+Shift+1", { databaseTypes: ["mysql"], sql: "MYSQL" })];
    expect(resolveSqlShortcutForDatabase(actions, "Mod+Shift+1", "mysql")?.id).toBe("mysql");
  });

  it("returns undefined when the current database is outside the scope", () => {
    const actions = [action("mysql", "Mod+Shift+1", { databaseTypes: ["mysql"] })];
    expect(resolveSqlShortcutForDatabase(actions, "Mod+Shift+1", "postgres")).toBeUndefined();
  });

  it("unique bindings collapse duplicate keys", () => {
    const actions = [action("mysql", "Mod+Shift+1", { databaseTypes: ["mysql"] }), action("sqlserver", "Mod+Shift+1", { databaseTypes: ["sqlserver"] })];
    expect(uniqueSqlShortcutBindings(actions)).toEqual(["Mod+Shift+1"]);
  });
});

describe("buildSqlShortcutExecutionSql", () => {
  it("builds dialect-aware select-limit SQL", () => {
    const selectLimit = action("top10", "Mod+Shift+1", { kind: "select-limit", limit: 10 });
    expect(buildSqlShortcutExecutionSql(selectLimit, "orders", "mysql")).toBe("SELECT *\nFROM orders\nLIMIT 10");
    expect(buildSqlShortcutExecutionSql(selectLimit, "orders", "sqlserver")).toBe("SELECT TOP 10 *\nFROM orders");
    expect(buildSqlShortcutExecutionSql(selectLimit, "orders", "oracle")).toBe("SELECT *\nFROM orders\nWHERE ROWNUM <= 10");
  });

  it("keeps quick actions bounded for unknown jdbc dialects", () => {
    const selectLimit = action("top10", "Mod+Shift+1", { kind: "select-limit", limit: 10 });
    expect(buildSqlShortcutExecutionSql(selectLimit, "orders", "jdbc")).toBe("SELECT *\nFROM orders\nLIMIT 10");
  });

  it("keeps plain templates unchanged aside from ${table}", () => {
    expect(buildSqlShortcutExecutionSql(action("count", "Mod+C", { sql: "SELECT COUNT(*) FROM ${table}" }), "t")).toBe("SELECT COUNT(*) FROM t");
  });

  it("prefers sqlByDatabaseType for the active database", () => {
    const scoped = action("per-db", "Mod+Shift+9", {
      sql: "SELECT * FROM ${table} /* default */",
      sqlByDatabaseType: {
        mysql: "SELECT * FROM ${table} /* mysql */",
        postgres: "SELECT * FROM ${table} /* postgres */",
      },
    });
    expect(buildSqlShortcutExecutionSql(scoped, "orders", "mysql")).toBe("SELECT * FROM orders /* mysql */");
    expect(buildSqlShortcutExecutionSql(scoped, "orders", "postgres")).toBe("SELECT * FROM orders /* postgres */");
    expect(buildSqlShortcutExecutionSql(scoped, "orders", "sqlserver")).toBe("SELECT * FROM orders /* default */");
    expect(buildSqlShortcutExecutionSql(scoped, "orders")).toBe("SELECT * FROM orders /* default */");
  });
});

describe("isBuiltinSqlShortcut", () => {
  it("recognizes shipped built-in ids", async () => {
    const { isBuiltinSqlShortcut, BUILTIN_SQL_SHORTCUT_COUNT_ID, BUILTIN_SQL_SHORTCUT_SELECT_LIMIT_ID } = await import("@/lib/sql/sqlShortcutActions");
    expect(isBuiltinSqlShortcut(BUILTIN_SQL_SHORTCUT_SELECT_LIMIT_ID)).toBe(true);
    expect(isBuiltinSqlShortcut(BUILTIN_SQL_SHORTCUT_COUNT_ID)).toBe(true);
    expect(isBuiltinSqlShortcut("custom")).toBe(false);
  });
});

describe("sqlShortcutAppliesToDatabase", () => {
  it("treats empty scope as all databases", () => {
    expect(sqlShortcutAppliesToDatabase({}, "mysql")).toBe(true);
    expect(sqlShortcutAppliesToDatabase({ databaseTypes: [] }, "mysql")).toBe(true);
  });

  it("requires a matching database type when scoped", () => {
    expect(sqlShortcutAppliesToDatabase({ databaseTypes: ["mysql"] }, "mysql")).toBe(true);
    expect(sqlShortcutAppliesToDatabase({ databaseTypes: ["mysql"] }, "postgres")).toBe(false);
    expect(sqlShortcutAppliesToDatabase({ databaseTypes: ["mysql"] }, undefined)).toBe(false);
  });
});

describe("buildSelectStarWithLimitSql", () => {
  it("covers the main dialect styles", () => {
    expect(buildSelectStarWithLimitSql("t", 5, "postgres")).toContain("LIMIT 5");
    expect(buildSelectStarWithLimitSql("t", 5, "sqlserver")).toContain("TOP 5");
    expect(buildSelectStarWithLimitSql("t", 5, "db2")).toContain("FETCH FIRST 5");
    expect(buildSelectStarWithLimitSql("t", 5, "informix")).toContain("FIRST 5");
    expect(buildSelectStarWithLimitSql("t", 5, "firebird")).toContain("ROWS 5");
    expect(buildSelectStarWithLimitSql("t", 5, "jdbc")).toBe("SELECT *\nFROM t\nLIMIT 5");
  });
});

describe("normalizeSqlShortcuts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("falls back to the built-in select-limit shortcut when the list is empty", async () => {
    const { normalizeEditorSettings, DEFAULT_EDITOR_SETTINGS } = await import("@/stores/settingsStore");
    const { DEFAULT_SQL_SHORTCUTS } = await import("@/lib/sql/sqlShortcutActions");
    expect(DEFAULT_EDITOR_SETTINGS.sqlShortcuts).toEqual(DEFAULT_SQL_SHORTCUTS);
    expect(normalizeEditorSettings({ sqlShortcuts: [] }).sqlShortcuts).toEqual(DEFAULT_SQL_SHORTCUTS);
    expect(DEFAULT_SQL_SHORTCUTS.map((item) => item.id)).toEqual(["builtin-select-limit", "builtin-count"]);
  });

  it("restores defaults even when previous settings had an empty sqlShortcuts list", async () => {
    const { normalizeEditorSettings } = await import("@/stores/settingsStore");
    const { DEFAULT_SQL_SHORTCUTS } = await import("@/lib/sql/sqlShortcutActions");
    const previous = normalizeEditorSettings({ sqlShortcuts: DEFAULT_SQL_SHORTCUTS });
    previous.sqlShortcuts = [];
    expect(normalizeEditorSettings({ sqlShortcuts: [] }, previous).sqlShortcuts.map((item) => item.id)).toEqual(["builtin-select-limit", "builtin-count"]);
  });

  it("appends missing built-in shortcuts without overwriting existing ones", async () => {
    const { normalizeEditorSettings } = await import("@/stores/settingsStore");
    const normalized = normalizeEditorSettings({
      sqlShortcuts: [
        action("builtin-select-limit", "Mod+Shift+9", {
          label: "Custom top",
          kind: "select-limit",
          limit: 5,
          sql: "ignored",
        }),
      ],
    }).sqlShortcuts;
    expect(normalized.map((item) => item.id)).toEqual(["builtin-select-limit", "builtin-count"]);
    expect(normalized[0]?.shortcut).toBe("Mod+Shift+9");
    expect(normalized[0]?.limit).toBe(5);
    expect(normalized[1]?.sql).toContain("COUNT(*)");
  });

  it("preserves a single shortcut through normalizeEditorSettings", async () => {
    const { normalizeEditorSettings } = await import("@/stores/settingsStore");
    const source = [action("count", "Mod+Shift+C", { label: "Count rows", sql: "SELECT COUNT(*) FROM ${table}" })];
    const normalized = normalizeEditorSettings({ sqlShortcuts: source }).sqlShortcuts;
    expect(normalized[0]).toEqual({
      id: "count",
      label: "Count rows",
      shortcut: "Mod+Shift+C",
      sql: "SELECT COUNT(*) FROM ${table}",
      enabled: true,
    });
    expect(normalized.map((item) => item.id)).toEqual(["count", "builtin-select-limit", "builtin-count"]);
  });

  it("normalizes select-limit kind and limit, and strips database scope", async () => {
    const { normalizeEditorSettings } = await import("@/stores/settingsStore");
    const normalized = normalizeEditorSettings({
      sqlShortcuts: [
        action("top", "Mod+Shift+1", {
          kind: "select-limit",
          limit: 10.8,
          databaseTypes: ["mysql", "mysql", "not-a-db" as never],
          sql: "ignored",
        }),
      ],
    }).sqlShortcuts;
    expect(normalized[0]).toMatchObject({
      id: "top",
      kind: "select-limit",
      limit: 10,
      sql: "SELECT *\nFROM ${table}\nLIMIT 10",
    });
    expect(normalized[0]?.databaseTypes).toBeUndefined();
  });

  it("preserves sqlByDatabaseType for custom templates and strips it from select-limit", async () => {
    const { normalizeEditorSettings } = await import("@/stores/settingsStore");
    const normalized = normalizeEditorSettings({
      sqlShortcuts: [
        action("custom", "Mod+Shift+3", {
          databaseTypes: ["mysql", "postgres"],
          sql: "SELECT * FROM ${table} /* default */",
          sqlByDatabaseType: {
            mysql: "SELECT * FROM ${table} /* mysql */",
            postgres: "SELECT 1 FROM ${table}",
            "not-a-db": "nope",
          } as never,
        }),
        action("top", "Mod+Shift+4", {
          kind: "select-limit",
          limit: 5,
          sqlByDatabaseType: { mysql: "ignored" } as never,
        }),
      ],
    }).sqlShortcuts;
    expect(normalized.find((item) => item.id === "custom")?.sqlByDatabaseType).toEqual({
      mysql: "SELECT * FROM ${table} /* mysql */",
      postgres: "SELECT 1 FROM ${table}",
    });
    expect(normalized.find((item) => item.id === "top")?.sqlByDatabaseType).toBeUndefined();
  });

  it("derives databaseTypes from sqlByDatabaseType when scope is missing", async () => {
    const { normalizeEditorSettings } = await import("@/stores/settingsStore");
    const { deriveSqlShortcutDatabaseTypes } = await import("@/lib/sql/sqlShortcutActions");
    expect(
      deriveSqlShortcutDatabaseTypes(undefined, {
        mysql: "SELECT 1 FROM ${table}",
        postgres: "SELECT 2 FROM ${table}",
      }),
    ).toEqual(["mysql", "postgres"]);
    const normalized = normalizeEditorSettings({
      sqlShortcuts: [
        action("imported", "Mod+Shift+5", {
          sql: "SELECT * FROM ${table} /* default */",
          sqlByDatabaseType: {
            mysql: "SELECT * FROM ${table} /* mysql */",
            oracle: "SELECT COUNT(*) FROM ${table}",
          },
        }),
      ],
    }).sqlShortcuts;
    const imported = normalized.find((item) => item.id === "imported");
    expect(imported?.databaseTypes).toEqual(["mysql", "oracle"]);
    expect(imported?.sqlByDatabaseType).toEqual({
      mysql: "SELECT * FROM ${table} /* mysql */",
      oracle: "SELECT COUNT(*) FROM ${table}",
    });
  });

  it("keeps modifier-order variants when loading settings", async () => {
    const { normalizeEditorSettings } = await import("@/stores/settingsStore");
    const normalized = normalizeEditorSettings({
      sqlShortcuts: [action("a", "Mod+Shift+1"), action("b", "Shift+Mod+1")],
    }).sqlShortcuts;
    expect(normalized.map((item) => item.id).slice(0, 2)).toEqual(["a", "b"]);
    expect(normalized.map((item) => item.id)).toEqual(["a", "b", "builtin-select-limit", "builtin-count"]);
  });

  it("drops a macOS-reserved shortcut so legacy/synced SQL shortcuts cannot hijack ⌘H", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const { normalizeEditorSettings } = await import("@/stores/settingsStore");
    // normalizeSqlShortcuts has no notion of a per-action "default", so clearing
    // the binding is the repair: an unbound action simply never fires.
    const normalized = normalizeEditorSettings({
      sqlShortcuts: [action("h", "Mod+H"), action("ok", "Mod+Shift+K")],
    }).sqlShortcuts;
    expect(normalized.find((item) => item.id === "h")?.shortcut).toBe("");
    expect(normalized.find((item) => item.id === "ok")?.shortcut).toBe("Mod+Shift+K");
    expect(normalized.map((item) => item.id)).toEqual(["h", "ok", "builtin-select-limit", "builtin-count"]);
  });

  it("keeps Ctrl+H on non-mac platforms where it is a legitimate SQL shortcut", async () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    const { normalizeEditorSettings } = await import("@/stores/settingsStore");
    const normalized = normalizeEditorSettings({
      sqlShortcuts: [action("h", "Mod+H")],
    }).sqlShortcuts;
    expect(normalized.find((item) => item.id === "h")?.shortcut).toBe("Mod+H");
  });

  it("blocks saving when canonical duplicates conflict at validation time", () => {
    const actions = [action("a", "Mod+Shift+1"), action("b", "Shift+Mod+1")];
    expect(hasSqlShortcutConflicts(actions, DEFAULT_SHORTCUT_SETTINGS)).toBe(true);
  });
});
