// @vitest-environment happy-dom
import { createApp, nextTick, type App, type ComponentPublicInstance } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import type { SavedSqlFile } from "@/types/database";

const mocks = vi.hoisted(() => ({
  exportSavedSqlFileContent: vi.fn(),
}));

vi.mock("@/lib/savedSql/savedSqlExport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/savedSql/savedSqlExport")>()),
  exportSavedSqlFileContent: mocks.exportSavedSqlFileContent,
}));

import SqlLibraryPanel from "../SqlLibraryPanel.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];
const timestamp = "2026-11-13T00:00:00Z";

function file(id: string, name: string, sql: string, sqlLoaded: boolean): SavedSqlFile {
  return { id, name, sql, sqlLoaded, connectionId: "", database: "metadata-only", createdAt: timestamp, updatedAt: timestamp };
}

async function mountPanel(staleFile: SavedSqlFile) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useSavedSqlStore();
  store.loadState = "loaded";
  store.files = [staleFile];
  vi.spyOn(store, "ensureAllFilesLoaded").mockResolvedValue(undefined);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(SqlLibraryPanel);
  app.use(pinia);
  app.use(i18n);
  const instance = app.mount(host) as ComponentPublicInstance;
  mounted.push({ app, host });
  await nextTick();
  return { host, instance, store };
}

beforeEach(() => {
  localStorage.clear();
  mocks.exportSavedSqlFileContent.mockReset();
  mocks.exportSavedSqlFileContent.mockResolvedValue("saved");
});

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
});

describe("SQL library file export (issue #14842)", () => {
  it("uses the refreshed filename for the save dialog", async () => {
    const staleFile = file("query", "before-rename.sql", "", false);
    const loadedFile = file("query", "after-rename.sql", "SELECT 42;", true);
    const { instance, store } = await mountPanel(staleFile);
    vi.spyOn(store, "ensureFileContent").mockResolvedValue(loadedFile);

    const setupState = instance.$.setupState as unknown as {
      contextTarget: SavedSqlFile;
      contextMenuItems: Array<{ label: string; action?: () => unknown }>;
    };
    setupState.contextTarget = staleFile;
    await nextTick();
    const exportAction = setupState.contextMenuItems.find((item) => item.label === i18n.global.t("sqlLibrary.exportFile"))?.action;
    expect(exportAction).toBeDefined();
    await exportAction!();

    expect(mocks.exportSavedSqlFileContent).toHaveBeenCalledExactlyOnceWith("SELECT 42;", "after-rename.sql");
  });
});
