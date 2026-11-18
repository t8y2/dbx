// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenTabsStatePayload } from "@/lib/app/openTabsPersistence";

const mocks = vi.hoisted(() => ({
  label: "main",
  records: new Map<string, unknown>(),
  created: vi.fn(),
  windows: new Set<string>(),
  maximize: vi.fn(async () => {}),
  invoke: vi.fn(),
  announce: vi.fn(async (_label: string) => {}),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/tabs/tabWindowTransfer", () => ({ notifyTabWindowsChanged: mocks.announce }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: mocks.label,
    outerPosition: async () => ({ x: 400, y: 200 }),
    innerSize: async () => ({ width: 2400, height: 1600 }),
    scaleFactor: async () => 2,
    isMaximized: async () => true,
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    constructor(label: string, options: unknown) {
      mocks.created(label, options);
      mocks.windows.add(label);
    }
    static async getByLabel(label: string) {
      return mocks.windows.has(label) ? {} : null;
    }
    async once(event: string, handler: () => void) {
      if (event === "tauri://created") queueMicrotask(handler);
      return () => {};
    }
    maximize = mocks.maximize;
  },
}));
import { saveWorkspaceWindow, loadWorkspaceWindow, restoreWorkspaceWindows, listWorkspaceWindows } from "../workspaceWindows";

const state = (id: string): OpenTabsStatePayload => ({
  tabs: [{ id, title: id, sql: `SELECT '${id}';`, connectionId: "conn", database: "db" }],
  activeTabId: id,
  groups: [{ id: "pane", tabIds: [id], activeTabId: id }],
  focusedGroupId: "pane",
  orientation: "vertical",
  sizes: [100],
});

beforeEach(() => {
  mocks.label = "main";
  mocks.records.clear();
  mocks.windows.clear();
  mocks.created.mockClear();
  mocks.announce.mockClear();
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "save_detached_tab_handoff") {
      mocks.records.set(args.tabId, JSON.parse(JSON.stringify(args.handoff)));
      return;
    }
    if (command === "load_detached_tab_handoff") return mocks.records.get(args.tabId) ?? null;
    if (command === "list_detached_tab_handoffs") return [...mocks.records.values()];
    throw new Error(command);
  });
});

describe("durable multi-window sessions", () => {
  it("keeps each window's SQL, selection, split layout and geometry in a separate durable record", async () => {
    await saveWorkspaceWindow(state("main-query"));
    mocks.label = "dbx-tab-a";
    await saveWorkspaceWindow(state("child-query"));
    expect(await loadWorkspaceWindow()).toEqual(state("child-query"));
    mocks.label = "main";
    expect(await loadWorkspaceWindow()).toEqual(state("main-query"));
    const records = await listWorkspaceWindows();
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ position: { x: 200, y: 100 }, size: { width: 1200, height: 800 }, maximized: true });
  });

  it("recreates each saved child once and routes it to its own saved state", async () => {
    mocks.label = "dbx-tab-a";
    await saveWorkspaceWindow(state("a"));
    mocks.label = "dbx-tab-b";
    await saveWorkspaceWindow(state("b"));
    mocks.records.set("legacy-tab", { schemaVersion: 1, tabId: "legacy-tab", tab: { id: "legacy-tab" } });
    mocks.label = "main";
    await restoreWorkspaceWindows();
    await restoreWorkspaceWindows();
    expect(mocks.created.mock.calls.map(([label]) => label)).toEqual(["dbx-tab-a", "dbx-tab-b"]);
    expect(mocks.announce.mock.calls.map(([label]) => label)).toEqual(["dbx-tab-a", "dbx-tab-b"]);
    expect(mocks.created.mock.calls[0][1]).toMatchObject({ width: 1200, height: 800, x: 200, y: 100 });
    expect(new URL(mocks.created.mock.calls[0][1].url).searchParams.get("dbxWorkspaceWindow")).toBe("dbx-tab-a");
    mocks.label = "dbx-tab-a";
    expect(await loadWorkspaceWindow()).toEqual(state("a"));
    await restoreWorkspaceWindows();
    expect(mocks.created).toHaveBeenCalledTimes(2);
  });

  it("surfaces a durable-write failure instead of reporting a saved session", async () => {
    mocks.invoke.mockRejectedValue(new Error("disk full"));
    await expect(saveWorkspaceWindow(state("draft"))).rejects.toThrow("disk full");
  });
});
