import { describe, expect, it } from "vitest";
import { DEFAULT_SHORTCUT_SETTINGS } from "@/lib/editor/shortcutRegistry";
import { enabledSqlShortcutActions, findSqlShortcutConflicts, hasSqlShortcutConflicts, resolveSqlShortcutTemplate } from "@/lib/sql/sqlShortcutActions";
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

describe("normalizeSqlShortcuts", () => {
  it("preserves a single shortcut through normalizeEditorSettings", async () => {
    const { normalizeEditorSettings } = await import("@/stores/settingsStore");
    const source = [action("count", "Mod+Shift+C", { label: "Count rows", sql: "SELECT COUNT(*) FROM ${table}" })];
    const normalized = normalizeEditorSettings({ sqlShortcuts: source }).sqlShortcuts;
    expect(normalized).toEqual([
      {
        id: "count",
        label: "Count rows",
        shortcut: "Mod+Shift+C",
        sql: "SELECT COUNT(*) FROM ${table}",
        enabled: true,
      },
    ]);
  });

  it("keeps modifier-order variants when loading settings", async () => {
    const { normalizeEditorSettings } = await import("@/stores/settingsStore");
    const normalized = normalizeEditorSettings({
      sqlShortcuts: [action("a", "Mod+Shift+1"), action("b", "Shift+Mod+1")],
    }).sqlShortcuts;
    expect(normalized).toHaveLength(2);
    expect(normalized.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("blocks saving when canonical duplicates conflict at validation time", () => {
    const actions = [action("a", "Mod+Shift+1"), action("b", "Shift+Mod+1")];
    expect(hasSqlShortcutConflicts(actions, DEFAULT_SHORTCUT_SETTINGS)).toBe(true);
  });
});
