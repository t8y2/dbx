// @vitest-environment happy-dom
import { computed, effectScope, reactive, type EffectScope } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryTab } from "@/types/database";
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), read: vi.fn(), watch: vi.fn(), apply: vi.fn(), ignore: vi.fn(), store: null as any }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/backend/api", () => ({ inspectExternalSqlFile: mocks.inspect, readExternalSqlFileSnapshot: mocks.read, watchSqlFileFolder: mocks.watch }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { externalSqlEditorMaxMb: 32 } }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => mocks.store }));
import { useExternalSqlFileChanges } from "../useExternalSqlFileChanges";
const original = { sizeBytes: 8, modifiedNs: "1", contentHash: "original" };
const latest = { sizeBytes: 8, modifiedNs: "2", contentHash: "latest" };
let scopes: EffectScope[] = [];
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.inspect.mockResolvedValue({ kind: "present", ...original });
  mocks.read.mockResolvedValue({ content: "SELECT 2", version: latest });
  mocks.watch.mockResolvedValue(vi.fn(async () => {}));
});
afterEach(() => {
  for (const scope of scopes) scope.stop();
  scopes = [];
  vi.useRealTimers();
});
async function mount() {
  const tab = reactive({ id: "file", mode: "query", sql: "SELECT 1", originalSql: "SELECT 1", externalSqlPath: "/sql/query.sql", externalSqlFileVersion: original } as QueryTab);
  mocks.store = { tabs: [tab], isTabDirty: (item: QueryTab) => item.sql !== item.originalSql, updateExternalSqlFileVersion: vi.fn(), applyExternalSqlFileSnapshot: mocks.apply, ignoreExternalSqlFileVersion: mocks.ignore };
  const scope = effectScope();
  scopes.push(scope);
  const errors = vi.fn();
  const changes = scope.run(() => useExternalSqlFileChanges({ activeTab: computed(() => tab), recreateFile: async () => true, saveAsFile: async () => true, closeTab: vi.fn(), reportError: errors }))!;
  await settle();
  const notify = mocks.watch.mock.calls.at(-1)![2] as () => void;
  return {
    tab,
    changes,
    scope,
    errors,
    async notify() {
      notify();
      await vi.advanceTimersByTimeAsync(250);
      await settle();
    },
  };
}
describe("external SQL file live updates", () => {
  it("uses metadata checks without reading unchanged file contents", async () => {
    await mount();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("automatically loads external changes into a clean editor", async () => {
    const { notify, changes } = await mount();
    mocks.inspect.mockResolvedValue({ kind: "present", ...latest });
    await notify();
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith("file", "SELECT 2", latest);
    expect(changes.pendingPrompt.value).toBeNull();
  });
  it("keeps unsaved edits and asks before replacing them", async () => {
    const { tab, notify, changes } = await mount();
    tab.sql = "SELECT local_edit";
    mocks.inspect.mockResolvedValue({ kind: "present", ...latest });
    await notify();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(changes.pendingPrompt.value).toMatchObject({ kind: "modified", dirty: true, path: "/sql/query.sql" });
    changes.resolvePrompt("keep");
    await settle();
    expect(mocks.ignore).toHaveBeenCalledWith("file", latest);
    expect(tab.sql).toBe("SELECT local_edit");
  });
  it("does not overwrite edits made while the external snapshot is being read", async () => {
    const { tab, notify, changes } = await mount();
    mocks.inspect.mockResolvedValue({ kind: "present", ...latest });
    let resolve!: (value: unknown) => void;
    mocks.read.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    await notify();
    tab.sql = "SELECT newly_typed";
    resolve({ content: "SELECT 2", version: latest });
    await settle();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(changes.pendingPrompt.value).toMatchObject({ dirty: true });
    changes.resolvePrompt("keep");
  });
  it("ignores an in-flight snapshot after its file path was moved", async () => {
    const { tab, notify, changes } = await mount();
    mocks.inspect.mockResolvedValue({ kind: "present", ...latest });
    let resolve!: (value: unknown) => void;
    mocks.read.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    await notify();
    tab.externalSqlPath = "/sql/sub/query.sql";
    mocks.inspect.mockResolvedValue({ kind: "present", ...original });
    resolve({ content: "SELECT old_path", version: latest });
    await settle();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(changes.pendingPrompt.value).toBeNull();
  });
  it("does not load a snapshot after the editor scope was disposed", async () => {
    const { notify, scope } = await mount();
    mocks.inspect.mockResolvedValue({ kind: "present", ...latest });
    let resolve!: (value: unknown) => void;
    mocks.read.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    await notify();
    scope.stop();
    resolve({ content: "SELECT 2", version: latest });
    await settle();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
