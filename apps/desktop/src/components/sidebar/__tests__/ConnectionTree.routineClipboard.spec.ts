// @vitest-environment happy-dom
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/types/database";
import { copySelectedConnectionsToClipboards, connectionPasteTargetGroupId } from "@/lib/sidebar/sidebarConnectionSelection";
import { formatSidebarTableCopyText } from "@/lib/sidebar/sidebarTableNameCopy";
import { routineClipboardEntryForSelection, routineClipboardPasteTarget } from "@/lib/table/routineClipboard";
import { compileConnectionTreeTestScript } from "./connectionTreeTestScript";

const compiled = compileConnectionTreeTestScript(["copySelectedSidebarNames", "requestSelectedSidebarPaste", "sidebarShortcutTargetAllowsAppShortcut"]);
const procedure = (extra: Partial<TreeNode> = {}): TreeNode => ({ id: "procedure-1", type: "procedure", label: "calculate_total(integer)", objectName: "calculate_total", signature: "integer", connectionId: "conn", database: "app", schema: "public", ...extra });
const routine = { connectionId: "conn", database: "app", schema: "public", name: "calculate_total", objectType: "PROCEDURE", signature: "integer" };

function harness(nodes: TreeNode[] = [procedure()]) {
  const store = {
    selectedTreeNodeId: nodes[0]?.id,
    treeClipboard: null as any,
    getConfig: vi.fn(() => ({ db_type: "postgres", driver_profile: "postgres" })),
    connectionIdentifierQuote: vi.fn(() => '"'),
    copyConnectionsToTreeClipboard: vi.fn(() => 0),
    groupIdForConnection: vi.fn(() => null),
    pasteConnectionClipboard: vi.fn().mockResolvedValue(1),
  };
  const copyToClipboard = vi.fn().mockResolvedValue(undefined);
  const registry = { request: vi.fn(() => true) };
  const bindings = {
    store,
    selectedSidebarNodesInVisibleOrder: () => nodes,
    flatTreeIndex: ref({ nodeById: new Map(nodes.map((node) => [node.id, node])) }),
    copySelectedConnectionsToClipboards,
    copyToClipboard,
    connectionPasteTargetGroupId,
    formatSidebarTableCopyText,
    connectionObjectTreeNodeSchema: (_config: unknown, database: string, schema?: string) => schema || database,
    effectiveDatabaseTypeForConnection: () => "postgres",
    routineClipboardEntryForSelection,
    routineClipboardPasteTarget,
    settingsStore: { editorSettings: { sidebarCopyTableNameSeparator: "newline", sidebarCopyTableNameIncludeSchema: false } },
    pasteHandlerRegistry: registry,
    sidebarDialogOpen: () => false,
    toast: vi.fn(),
    t: (key: string) => key,
  };
  const actions = new Function(...Object.keys(bindings), `${compiled}; return { copySelectedSidebarNames, requestSelectedSidebarPaste, sidebarShortcutTargetAllowsAppShortcut };`)(...Object.values(bindings));
  return { ...actions, store, registry, copyToClipboard };
}

afterEach(() => document.body.replaceChildren());

describe("ConnectionTree routine clipboard keyboard routing (#13903)", () => {
  it("retains a typed routine clipboard while still copying the visible name to the system clipboard", async () => {
    const view = harness();
    expect(view.copySelectedSidebarNames()).toBe(true);
    expect(view.store.treeClipboard).toEqual({ kind: "routine-copy", routine });
    expect(view.copyToClipboard).toHaveBeenCalledWith("calculate_total(integer)");
    await Promise.resolve();
  });

  it("routes a routine paste through the existing selected-row registry", () => {
    const view = harness();
    view.store.treeClipboard = { kind: "routine-copy", routine };
    expect(view.requestSelectedSidebarPaste()).toBe(true);
    expect(view.registry.request).toHaveBeenCalledWith("procedure-1");
  });

  it("retains the routine clipboard when OS clipboard writing fails", async () => {
    const view = harness();
    view.copyToClipboard.mockRejectedValueOnce(new Error("clipboard unavailable"));
    expect(view.copySelectedSidebarNames()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(view.store.treeClipboard).toEqual({ kind: "routine-copy", routine });
    expect(view.requestSelectedSidebarPaste()).toBe(true);
  });

  it("does not consume a routine paste at another schema or unrelated selected object", () => {
    for (const extra of [{ schema: "other" }, { database: "other" }, { connectionId: "other" }, { type: "table" as const }]) {
      const view = harness([procedure(extra)]);
      view.store.treeClipboard = { kind: "routine-copy", routine };
      expect(view.requestSelectedSidebarPaste()).toBe(false);
      expect(view.registry.request).not.toHaveBeenCalled();
    }
  });

  it("keeps the existing table clipboard and paste behavior", async () => {
    const view = harness([procedure({ id: "table-1", type: "table", label: "orders" })]);
    expect(view.copySelectedSidebarNames()).toBe(true);
    expect(view.store.treeClipboard).toMatchObject({ kind: "table-copy", tables: [{ tableName: "orders" }] });
    expect(view.requestSelectedSidebarPaste()).toBe(true);
    expect(view.registry.request).toHaveBeenCalledWith("table-1");
    await Promise.resolve();
  });

  it("keeps connection copy and paste on the existing connection path", async () => {
    const view = harness([procedure({ id: "conn", type: "connection", label: "Connection", database: undefined, schema: undefined })]);
    view.store.copyConnectionsToTreeClipboard.mockImplementation(() => {
      view.store.treeClipboard = { kind: "connection-copy", connections: [] };
      return 1;
    });
    expect(view.copySelectedSidebarNames()).toBe(true);
    expect(view.store.treeClipboard.kind).toBe("connection-copy");
    expect(view.copyToClipboard).toHaveBeenCalledWith("Connection");
    expect(view.requestSelectedSidebarPaste()).toBe(true);
    expect(view.store.pasteConnectionClipboard).toHaveBeenCalledWith(null);
    expect(view.registry.request).not.toHaveBeenCalled();
    await Promise.resolve();
  });

  it("does not capture copy/paste inside editable fields or dialogs", () => {
    const view = harness();
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(input, textarea, editable, dialog);
    expect(view.sidebarShortcutTargetAllowsAppShortcut(input)).toBe(false);
    expect(view.sidebarShortcutTargetAllowsAppShortcut(textarea)).toBe(false);
    expect(view.sidebarShortcutTargetAllowsAppShortcut(editable)).toBe(false);
    expect(view.sidebarShortcutTargetAllowsAppShortcut(button)).toBe(false);
    expect(view.sidebarShortcutTargetAllowsAppShortcut(document.body)).toBe(true);
  });
});
