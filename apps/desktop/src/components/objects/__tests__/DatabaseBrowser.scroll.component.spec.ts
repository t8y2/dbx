// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DatabaseBrowser from "../DatabaseBrowser.vue";
import { provideTabUiState, TAB_UI_STATE_TRACK_DEBOUNCE_MS } from "@/lib/tabs/tabUiState";
import type { ConnectionConfig } from "@/types/database";

const testDatabases = Array.from({ length: 30 }, (_, index) => ({
  name: `db_${String(index + 1).padStart(2, "0")}`,
  size_bytes: 1024 * (index + 1),
  created_at: "2026-01-01 00:00:00",
  updated_at: "2026-01-02 00:00:00",
  comment: `Database ${index + 1}`,
  default_charset: "utf8mb4",
  default_collation: "utf8mb4_0900_ai_ci",
}));

const mocks = vi.hoisted(() => ({
  listDatabases: vi.fn(),
  listDatabaseMetadata: vi.fn(),
  editorSettings: {
    objectBrowserViewMode: "list" as "list" | "grid" | "compact",
    objectBrowserCompactWidth: 160,
  },
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: (...args: unknown[]) => mocks.listDatabases(...args),
  listDatabaseMetadata: (...args: unknown[]) => mocks.listDatabaseMetadata(...args),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    setDefaultDatabase: vi.fn(),
    clearDefaultDatabase: vi.fn(),
  }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    openObjectBrowser: vi.fn(),
    createTab: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: reactive(mocks.editorSettings),
    updateEditorSettings: (patch: Partial<typeof mocks.editorSettings>) => {
      Object.assign(reactive(mocks.editorSettings), patch);
    },
  }),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: ref("en-US"),
  }),
}));

vi.mock("@/components/sidebar/SidebarTreeRuntimeHost.vue", () => ({
  default: defineComponent({
    setup() {
      return () => null;
    },
  }),
}));

vi.mock("@/components/sidebar/SidebarTreeItemDialogs.vue", () => ({
  default: defineComponent({
    setup() {
      return () => null;
    },
  }),
}));

vi.mock("@/composables/useToolbarOverflow", () => ({
  useToolbarOverflow: () => ({
    tier: ref(0),
  }),
}));

describe("DatabaseBrowser scroll position preservation (#12432)", () => {
  let app: App | undefined;
  let host: HTMLElement | undefined;

  const testConnection: ConnectionConfig = {
    id: "conn-mysql-1",
    name: "MySQL Prod",
    db_type: "mysql",
  };

  beforeEach(() => {
    mocks.listDatabases.mockResolvedValue(testDatabases);
    mocks.listDatabaseMetadata.mockResolvedValue([]);
    mocks.editorSettings.objectBrowserViewMode = "list";
    mocks.editorSettings.objectBrowserCompactWidth = 160;
  });

  afterEach(() => {
    vi.useRealTimers();
    app?.unmount();
    host?.remove();
    app = undefined;
    host = undefined;
    vi.clearAllMocks();
  });

  it("updates compact width immediately without losing cards", async () => {
    mocks.editorSettings.objectBrowserViewMode = "compact";
    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(DatabaseBrowser, { connection: testConnection });
    app.mount(host);
    await vi.waitFor(() => expect(host!.querySelectorAll(".grid.content-start .h-7")).toHaveLength(testDatabases.length));
    const scroller = host.querySelector<HTMLElement>(".grid.content-start")!;
    expect(scroller.style.gridTemplateColumns).toBe("repeat(auto-fill, minmax(min(160px, 100%), 1fr))");
    const select = host.querySelector<HTMLSelectElement>("[data-compact-width-select]")!;
    select.value = "200";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    expect(scroller.style.gridTemplateColumns).toBe("repeat(auto-fill, minmax(min(200px, 100%), 1fr))");
    expect(mocks.editorSettings.objectBrowserCompactWidth).toBe(200);
    expect(scroller.querySelectorAll(".h-7")).toHaveLength(testDatabases.length);
  });

  it("restores scrollTop from tab UI state when mounting in list view", async () => {
    let capturedState: Record<string, any> = {};
    const Parent = defineComponent({
      setup() {
        provideTabUiState(() => ({
          snapshot: {
            DatabaseBrowser: {
              scrollTop: 350,
              scrollLeft: 0,
            },
          },
          update: (patch) => {
            Object.assign(capturedState, patch);
          },
        }));
        return () => h(DatabaseBrowser, { connection: testConnection });
      },
    });

    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(Parent);
    app.mount(host);

    await vi.waitFor(() => {
      const rows = host!.querySelectorAll(".grid.h-\\[34px\\]");
      expect(rows.length).toBe(testDatabases.length);
    });

    await new Promise((resolve) => requestAnimationFrame(resolve));
    await nextTick();

    const scroller = host.querySelector<HTMLElement>(".overflow-auto");
    expect(scroller).not.toBeNull();
    expect(scroller?.scrollTop).toBe(350);
  });

  it("tracks vertical scrolling and debounces updates to tab UI state", async () => {
    let trackedUiState: Record<string, any> = {};

    const Parent = defineComponent({
      setup() {
        provideTabUiState(() => ({
          snapshot: { DatabaseBrowser: {} },
          update: (patch) => {
            Object.assign(trackedUiState, patch);
          },
        }));
        return () => h(DatabaseBrowser, { connection: testConnection });
      },
    });

    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(Parent);
    app.mount(host);

    await vi.waitFor(() => {
      const rows = host!.querySelectorAll(".grid.h-\\[34px\\]");
      expect(rows.length).toBe(testDatabases.length);
    });

    const scroller = host.querySelector<HTMLElement>(".overflow-auto");
    expect(scroller).not.toBeNull();

    vi.useFakeTimers();

    // User scrolls down
    Object.defineProperty(scroller, "scrollTop", { value: 480, writable: true });
    scroller!.dispatchEvent(new Event("scroll"));

    await nextTick();
    expect(trackedUiState.DatabaseBrowser?.scrollTop).toBeUndefined();

    // Advance past debounce timer
    vi.advanceTimersByTime(TAB_UI_STATE_TRACK_DEBOUNCE_MS + 20);
    await nextTick();

    expect(trackedUiState.DatabaseBrowser?.scrollTop).toBe(480);
    vi.useRealTimers();
  });

  it("resets scrollTop when user enters a search query", async () => {
    let capturedState: Record<string, any> = {};
    const Parent = defineComponent({
      setup() {
        provideTabUiState(() => ({
          snapshot: {
            DatabaseBrowser: {
              scrollTop: 200,
            },
          },
          update: (patch) => {
            Object.assign(capturedState, patch);
          },
        }));
        return () => h(DatabaseBrowser, { connection: testConnection });
      },
    });

    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(Parent);
    app.mount(host);

    await vi.waitFor(() => {
      const rows = host!.querySelectorAll(".grid.h-\\[34px\\]");
      expect(rows.length).toBe(testDatabases.length);
    });

    await new Promise((resolve) => requestAnimationFrame(resolve));
    await nextTick();

    const scroller = host.querySelector<HTMLElement>(".overflow-auto");
    expect(scroller?.scrollTop).toBe(200);

    // Enter search query
    const input = host.querySelector<HTMLInputElement>("input");
    expect(input).not.toBeNull();
    input!.value = "db_01";
    input!.dispatchEvent(new Event("input"));

    await nextTick();
    expect(scroller?.scrollTop).toBe(0);
  });

  it("restores scrollTop from tab UI state when mounting in grid view", async () => {
    mocks.editorSettings.objectBrowserViewMode = "grid";

    const Parent = defineComponent({
      setup() {
        provideTabUiState(() => ({
          snapshot: {
            DatabaseBrowser: {
              scrollTop: 180,
            },
          },
          update: vi.fn(),
        }));
        return () => h(DatabaseBrowser, { connection: testConnection });
      },
    });

    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(Parent);
    app.mount(host);

    await vi.waitFor(() => {
      const cards = host!.querySelectorAll(".flex.min-h-28");
      expect(cards.length).toBe(testDatabases.length);
    });

    await new Promise((resolve) => requestAnimationFrame(resolve));
    await nextTick();

    const gridScroller = host.querySelector<HTMLElement>(".grid-cols-\\[repeat\\(auto-fill\\,minmax\\(160px\\,1fr\\)\\)\\]");
    expect(gridScroller).not.toBeNull();
    expect(gridScroller?.scrollTop).toBe(180);
  });

  it("resets scrollTop when sort column or direction changes", async () => {
    const Parent = defineComponent({
      setup() {
        provideTabUiState(() => ({
          snapshot: {
            DatabaseBrowser: {
              scrollTop: 240,
            },
          },
          update: vi.fn(),
        }));
        return () => h(DatabaseBrowser, { connection: testConnection });
      },
    });

    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(Parent);
    app.mount(host);

    await vi.waitFor(() => {
      const rows = host!.querySelectorAll(".grid.h-\\[34px\\]");
      expect(rows.length).toBe(testDatabases.length);
    });

    await new Promise((resolve) => requestAnimationFrame(resolve));
    await nextTick();

    const scroller = host.querySelector<HTMLElement>(".overflow-auto");
    expect(scroller?.scrollTop).toBe(240);

    // Click sort header button
    const sortBtn = host.querySelector<HTMLButtonElement>("button.gap-1");
    expect(sortBtn).not.toBeNull();
    sortBtn!.click();

    await nextTick();
    expect(scroller?.scrollTop).toBe(0);
  });

  it("restores scrollLeft from tab UI state when mounting in list view", async () => {
    const Parent = defineComponent({
      setup() {
        provideTabUiState(() => ({
          snapshot: {
            DatabaseBrowser: {
              scrollTop: 100,
              scrollLeft: 150,
            },
          },
          update: vi.fn(),
        }));
        return () => h(DatabaseBrowser, { connection: testConnection });
      },
    });

    host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(Parent);
    app.mount(host);

    await vi.waitFor(() => {
      const rows = host!.querySelectorAll(".grid.h-\\[34px\\]");
      expect(rows.length).toBe(testDatabases.length);
    });

    await new Promise((resolve) => requestAnimationFrame(resolve));
    await nextTick();

    const outer = host.querySelector<HTMLElement>(".overflow-x-auto");
    const scroller = host.querySelector<HTMLElement>(".overflow-auto");
    expect(scroller?.scrollTop).toBe(100);
    expect(outer?.scrollLeft).toBe(150);
  });
});
