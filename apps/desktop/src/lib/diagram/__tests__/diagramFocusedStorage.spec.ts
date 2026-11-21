import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLiveTablePatches, loadDraftTables, loadLiveTablePatches, loadPersistedLayers, loadPersistedPositions, saveDraftTables, saveFocusedDiagramState, saveLiveTablePatches, savePersistedLayers, savePersistedPositions } from "../draft-storage";
import type { DiagramTable } from "../erDiagram";

const context = ["c", "db", "public"] as const;
const live = (name: string, schema = "public"): DiagramTable => ({ name, schema, columns: [], foreignKeys: [] });
const draft = (name: string): DiagramTable => ({ ...live(name), origin: "draft" });
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

describe("focused persistence", () => {
  it("opening, moving, and refreshing a subset preserves unrelated drafts, patches, layers, and positions", () => {
    saveDraftTables([draft("unrelated_draft")], ...context);
    saveLiveTablePatches([{ ...live("unrelated"), pendingDrop: true }], ...context);
    savePersistedPositions({ unrelated: { x: 100, y: 200 } }, ...context);
    const layers = [{ id: "layer", name: "saved", tableNames: ["root", "unrelated"], color: "red", visible: true, collapsed: false }];
    savePersistedLayers(layers, ...context);
    const root = live("root");
    for (const positions of [{}, { root: { x: 12, y: 34 } }, {}]) saveFocusedDiagramState([root], [root], positions, [{ ...layers[0], tableNames: ["root"] }], ...context);
    expect(loadDraftTables(...context).map((table) => table.name)).toEqual(["unrelated_draft"]);
    expect(loadLiveTablePatches(...context)[0].tableName).toBe("unrelated");
    expect(loadPersistedPositions(...context)).toEqual({ unrelated: { x: 100, y: 200 }, root: { x: 12, y: 34 } });
    expect(loadPersistedLayers(...context)[0].tableNames).toEqual(["root", "unrelated"]);
  });

  it("upserts and removes only the edited live patch, keeping same-name patches in other schemas", () => {
    const root = live("root");
    saveLiveTablePatches(
      [
        { ...live("root", "other"), pendingDrop: true },
        { ...live("unrelated"), pendingDrop: true },
      ],
      ...context,
    );
    const edited = { ...root, pendingDrop: true };
    saveFocusedDiagramState([edited], [root], {}, [], ...context);
    expect(loadLiveTablePatches(...context)).toHaveLength(3);
    saveFocusedDiagramState([root], [edited], {}, [], ...context);
    expect(loadLiveTablePatches(...context).map((patch) => [patch.schema, patch.tableName])).toEqual([
      ["other", "root"],
      ["public", "unrelated"],
    ]);
  });

  it("creates, renames and deletes only the affected draft", () => {
    saveDraftTables([draft("unrelated")], ...context);
    const first = draft("new");
    const renamed = draft("renamed");
    saveFocusedDiagramState([first], [], {}, [], ...context);
    saveFocusedDiagramState([renamed], [first], {}, [], ...context);
    expect(loadDraftTables(...context).map((table) => table.name)).toEqual(["unrelated", "renamed"]);
    saveFocusedDiagramState([], [renamed], {}, [], ...context);
    expect(loadDraftTables(...context).map((table) => table.name)).toEqual(["unrelated"]);
  });

  it("retains unloaded membership even when the visible layer is removed", () => {
    savePersistedLayers([{ id: "layer", name: "saved", tableNames: ["root", "unrelated"], color: "red", visible: true, collapsed: false }], ...context);
    saveFocusedDiagramState([live("root")], [live("root")], {}, [], ...context);
    expect(loadPersistedLayers(...context)[0].tableNames).toEqual(["unrelated"]);
  });

  it("applies qualified and legacy patches only to their schema", () => {
    const tables = [live("root"), live("root", "other")];
    const patches = [{ tableName: "root", pendingColumns: [], pendingDrop: true }];
    expect(applyLiveTablePatches(tables, patches, "public").map((table) => !!table.pendingDrop)).toEqual([true, false]);
    expect(applyLiveTablePatches(tables, [{ ...patches[0], schema: "other" }]).map((table) => !!table.pendingDrop)).toEqual([false, true]);
  });

  it("cross-schema edits preserve legacy state belonging to an unloaded root-schema table", () => {
    const stored = { ...live("same"), schema: undefined, pendingDrop: true };
    saveLiveTablePatches([stored], ...context);
    savePersistedPositions({ same: { x: 100, y: 200 } }, ...context);
    savePersistedLayers([{ id: "layer", name: "saved", tableNames: ["same"], color: "red", visible: true, collapsed: false }], ...context);
    const other = live("same", "other");
    saveFocusedDiagramState([{ ...other, pendingDrop: true }], [other], { same: { x: 1, y: 2 }, "other.same": { x: 3, y: 4 } }, [], ...context);
    expect(loadLiveTablePatches(...context)).toHaveLength(2);
    expect(loadPersistedPositions(...context).same).toEqual({ x: 100, y: 200 });
    expect(loadPersistedLayers(...context)[0].tableNames).toEqual(["same"]);
  });
});
