import { describe, expect, it, vi } from "vitest";
import { matchesShortcut } from "@/lib/editor/keyboardShortcuts";
import { createQueryEditorSqlShortcutDomHandler, isCharacterProducingShortcut } from "@/lib/editor/queryEditorSqlShortcut";
import type { SqlShortcutAction } from "@/types/database";
// pi-lens-ignore: typescript:2307
import type { EditorView } from "@codemirror/view";

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

describe("isCharacterProducingShortcut", () => {
  it("treats Shift+letter shortcuts as character-producing", () => {
    expect(isCharacterProducingShortcut("Shift+U")).toBe(true);
    expect(isCharacterProducingShortcut("u")).toBe(true);
  });

  it("treats modifier shortcuts as non character-producing", () => {
    expect(isCharacterProducingShortcut("Mod+Shift+9")).toBe(false);
    expect(isCharacterProducingShortcut("Shift+Alt+U")).toBe(false);
    expect(isCharacterProducingShortcut("Shift+Enter")).toBe(false);
  });
});

describe("matchesShortcut for Shift+U", () => {
  it("matches uppercase U with shift held", () => {
    expect(matchesShortcut({ key: "U", shiftKey: true }, "Shift+U", "MacIntel")).toBe(true);
  });
});

function keydownEvent(overrides: { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }) {
  return {
    ...overrides,
    preventDefault: vi.fn(),
  };
}

describe("createQueryEditorSqlShortcutDomHandler", () => {
  const view = {} as EditorView;

  it("runs the action and prevents default when there is a selection", () => {
    const runAction = vi.fn(() => true);
    const handler = createQueryEditorSqlShortcutDomHandler(() => [action("a", "Shift+U")], runAction, undefined, "MacIntel");
    const event = keydownEvent({ key: "U", shiftKey: true });

    expect(handler(event as unknown as KeyboardEvent, view)).toBe(true);
    expect(runAction).toHaveBeenCalledOnce();
    expect(runAction).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), view, event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("does not intercept when there is no selection", () => {
    const runAction = vi.fn(() => false);
    const handler = createQueryEditorSqlShortcutDomHandler(() => [action("a", "Shift+U")], runAction, undefined, "MacIntel");
    const event = keydownEvent({ key: "U", shiftKey: true });

    expect(handler(event as unknown as KeyboardEvent, view)).toBe(false);
    expect(runAction).toHaveBeenCalledOnce();
    expect(runAction).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), view, event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores non character-producing shortcuts", () => {
    const runAction = vi.fn(() => true);
    const handler = createQueryEditorSqlShortcutDomHandler(() => [action("a", "Mod+Shift+9")], runAction, undefined, "MacIntel");
    const event = keydownEvent({ key: "9", metaKey: true, shiftKey: true });

    expect(handler(event as unknown as KeyboardEvent, view)).toBe(false);
    expect(runAction).not.toHaveBeenCalled();
  });

  it("resolves the action for the active database type", () => {
    const runAction = vi.fn(() => true);
    const handler = createQueryEditorSqlShortcutDomHandler(
      () => [action("mysql", "Shift+U", { databaseTypes: ["mysql"] }), action("sqlserver", "Shift+U", { databaseTypes: ["sqlserver"] })],
      runAction,
      () => "sqlserver",
      "MacIntel",
    );
    const event = keydownEvent({ key: "U", shiftKey: true });

    expect(handler(event as unknown as KeyboardEvent, view)).toBe(true);
    expect(runAction).toHaveBeenCalledWith(expect.objectContaining({ id: "sqlserver" }), view, event);
  });

  it("does not run a scoped action on an unrelated database", () => {
    const runAction = vi.fn(() => true);
    const handler = createQueryEditorSqlShortcutDomHandler(
      () => [action("mysql", "Shift+U", { databaseTypes: ["mysql"] })],
      runAction,
      () => "postgres",
      "MacIntel",
    );
    const event = keydownEvent({ key: "U", shiftKey: true });

    expect(handler(event as unknown as KeyboardEvent, view)).toBe(false);
    expect(runAction).not.toHaveBeenCalled();
  });
});
