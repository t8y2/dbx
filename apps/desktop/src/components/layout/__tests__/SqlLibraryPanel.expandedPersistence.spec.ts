// @vitest-environment happy-dom
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import type { SavedSqlFile, SavedSqlFolder } from "@/types/database";
import SqlLibraryPanel from "../SqlLibraryPanel.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];
const timestamp = "2026-10-01T00:00:00Z";

function makeFolder(id: string, name: string, parentFolderId?: string): SavedSqlFolder {
  return { id, name, connectionId: "c1", parentFolderId, createdAt: timestamp, updatedAt: timestamp };
}

function makeFile(id: string, name: string, folderId?: string): SavedSqlFile {
  return { id, name, sql: "SELECT 1;", sqlLoaded: true, connectionId: "c1", database: "app", folderId, createdAt: timestamp, updatedAt: timestamp };
}

async function mountLibrary(folders: SavedSqlFolder[], files: SavedSqlFile[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useSavedSqlStore();
  store.loadState = "loaded";
  store.folders = [...folders];
  store.files = [...files];
  vi.spyOn(store, "ensureAllFilesLoaded").mockResolvedValue(undefined);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(SqlLibraryPanel);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });
  await nextTick();
  return { host, store, app };
}

function visibleFileIds(host: HTMLElement): string[] {
  return [...host.querySelectorAll("[data-sql-library-file]")].map((row) => row.getAttribute("data-sql-library-file")!);
}

function folderElement(host: HTMLElement, folderId: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-sql-library-folder="${folderId}"]`);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
});

describe("SqlLibraryPanel expanded state persistence (issue #13593)", () => {
  it("defaults to collapsed and preserves expanded state across panel remounts", async () => {
    const folders = [makeFolder("f1", "Queries"), makeFolder("f2", "Reports")];
    const files = [makeFile("q1", "query1.sql", "f1"), makeFile("r1", "report1.sql", "f2")];

    // 1st mount: opening panel for the first time
    const first = await mountLibrary(folders, files);
    expect(visibleFileIds(first.host)).toEqual([]); // both folders collapsed

    // Expand folder f1 by clicking it
    folderElement(first.host, "f1")!.click();
    await nextTick();

    // Now f1 is expanded, showing q1, while f2 remains collapsed
    expect(visibleFileIds(first.host)).toEqual(["q1"]);

    // Unmount (simulating closing the panel)
    first.app.unmount();
    first.host.remove();
    mounted.length = 0;

    // 2nd mount (simulating reopening the panel)
    const second = await mountLibrary(folders, files);
    // f1 should STILL be expanded, f2 should STILL be collapsed!
    expect(visibleFileIds(second.host)).toEqual(["q1"]);

    // Expand f2 as well
    folderElement(second.host, "f2")!.click();
    await nextTick();
    expect(visibleFileIds(second.host)).toEqual(["q1", "r1"]);

    // Unmount and remount again
    second.app.unmount();
    second.host.remove();
    mounted.length = 0;

    const third = await mountLibrary(folders, files);
    expect(visibleFileIds(third.host)).toEqual(["q1", "r1"]);
  });

  it("persists collapsed-all state", async () => {
    const folders = [makeFolder("f1", "Queries")];
    const files = [makeFile("q1", "query1.sql", "f1")];

    const first = await mountLibrary(folders, files);
    // Expand folder f1
    folderElement(first.host, "f1")!.click();
    await nextTick();
    expect(visibleFileIds(first.host)).toEqual(["q1"]);

    // Click collapse all button
    const collapseAllBtn = first.host.querySelector<HTMLButtonElement>("button:has(.lucide-chevrons-down-up)");
    expect(collapseAllBtn).not.toBeNull();
    collapseAllBtn!.click();
    await nextTick();
    expect(visibleFileIds(first.host)).toEqual([]);

    // Remount
    first.app.unmount();
    first.host.remove();
    mounted.length = 0;

    const second = await mountLibrary(folders, files);
    expect(visibleFileIds(second.host)).toEqual([]);
  });
});
