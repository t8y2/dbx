// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DatabaseBrowser from "../DatabaseBrowser.vue";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listDatabases: vi.fn(),
  listDatabaseMetadata: vi.fn(),
  listDatabaseStorage: vi.fn(),
  toast: vi.fn(),
  copyToClipboard: vi.fn(),
  listSchemaInfos: vi.fn(),
  listSchemas: vi.fn(),
  openObjectBrowser: vi.fn(),
  editorSettings: {
    objectBrowserViewMode: "list" as "list" | "grid" | "compact",
    objectBrowserCompactWidth: 160,
  },
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: (...args: unknown[]) => mocks.listDatabases(...args),
  listDatabaseMetadata: (...args: unknown[]) => mocks.listDatabaseMetadata(...args),
  listDatabaseStorage: (...args: unknown[]) => mocks.listDatabaseStorage(...args),
  listSchemaInfos: (...args: unknown[]) => mocks.listSchemaInfos(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    setDefaultDatabase: vi.fn(),
    clearDefaultDatabase: vi.fn(),
  }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    openObjectBrowser: (...args: unknown[]) => mocks.openObjectBrowser(...args),
    createTab: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: mocks.editorSettings,
    updateEditorSettings: (patch: Partial<typeof mocks.editorSettings>) => {
      Object.assign(mocks.editorSettings, patch);
    },
  }),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: { value: "en-US" },
  }),
}));

vi.mock("@/components/sidebar/SidebarTreeRuntimeHost.vue", () => ({
  default: {
    setup(_props: unknown, { expose }: { expose: (value: unknown) => void }) {
      expose({ buildContextMenu: () => [] });
      return () => null;
    },
  },
}));

vi.mock("@/components/sidebar/SidebarTreeItemDialogs.vue", () => ({
  default: {
    setup() {
      return () => null;
    },
  },
}));

vi.mock("@/composables/useToolbarOverflow", () => ({
  useToolbarOverflow: () => ({
    tier: { value: 0 },
  }),
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: (...args: unknown[]) => mocks.copyToClipboard(...args) }));
vi.mock("@/components/ui/CustomContextMenu.vue", () => ({
  default: defineComponent({
    props: ["items"],
    setup(props, { slots }) {
      return () =>
        h("div", { "data-context-row": "" }, [
          slots.default?.({ onContextMenu: () => undefined }),
          h(
            "button",
            {
              "data-capacity": "",
              onClick: () =>
                props
                  .items()
                  .find((item: { label: string }) => item.label === "objects.loadCapacity")
                  ?.action(),
            },
            "capacity",
          ),
        ]);
    },
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("MySQL explicit database capacity", () => {
  let app: App;
  let host: HTMLElement;
  const connection = ref({ id: "mysql-a", name: "MySQL", db_type: "mysql" } as ConnectionConfig);
  beforeEach(() => {
    vi.clearAllMocks();
    connection.value = { id: "mysql-a", name: "MySQL", db_type: "mysql" } as ConnectionConfig;
    mocks.listDatabases.mockResolvedValue([{ name: "app" }, { name: "other" }]);
    mocks.listDatabaseMetadata.mockResolvedValue([]);
    mocks.listDatabaseStorage.mockResolvedValue([{ name: "app", size_bytes: 1024 }]);
    host = document.createElement("div");
    document.body.append(host);
    app = createApp({ setup: () => () => h(DatabaseBrowser, { connection: connection.value }) });
  });
  afterEach(() => {
    app.unmount();
    host.remove();
  });
  async function mount() {
    app.mount(host);
    await vi.waitFor(() => expect(host.querySelectorAll("[data-capacity]")).toHaveLength(2));
  }
  function capacity() {
    (host.querySelector("[data-capacity]") as HTMLButtonElement).click();
  }

  it("copies the filtered database names as separate clipboard lines", async () => {
    await mount();
    const copyButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("objects.copyNames"));
    expect(copyButton).toBeDefined();
    copyButton!.click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith("app\nother"));
  });

  it("offers one table copy option for the fully loaded database list", async () => {
    await mount();
    host.querySelector<HTMLButtonElement>("[data-database-copy-menu]")!.click();
    await nextTick();

    const tableCopyItems = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((item) => item.textContent?.includes("objects.copyCurrentPageAsTable") || item.textContent?.includes("objects.copyAllAsTable"));
    expect(tableCopyItems).toHaveLength(1);
    expect(tableCopyItems[0].textContent).toContain("objects.copyCurrentPageAsTable");
    tableCopyItems[0].click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith(expect.stringContaining("objects.name")));
  });

  it("loads only selected capacity once and preserves it after late attributes", async () => {
    const attributes = deferred<unknown[]>();
    const sizes = deferred<unknown[]>();
    mocks.listDatabaseMetadata.mockReturnValue(attributes.promise);
    mocks.listDatabaseStorage.mockReturnValue(sizes.promise);
    await mount();
    expect(mocks.listDatabaseStorage).not.toHaveBeenCalled();
    capacity();
    capacity();
    expect(mocks.listDatabaseStorage).toHaveBeenCalledExactlyOnceWith("mysql-a", ["app"]);
    sizes.resolve([{ name: "app", size_bytes: 1024 }]);
    await vi.waitFor(() => expect(host.textContent).toContain("1.00 KB"));
    attributes.resolve([{ name: "app", size_bytes: null, default_charset: "utf8" }]);
    await vi.waitFor(() => expect(host.textContent).toContain("utf8"));
    expect(host.textContent).toContain("1.00 KB");
  });

  it("ignores a previous connection's capacity result", async () => {
    const oldSize = deferred<unknown[]>();
    mocks.listDatabaseStorage.mockReturnValueOnce(oldSize.promise);
    await mount();
    capacity();
    connection.value = { ...connection.value, id: "mysql-b" };
    await vi.waitFor(() => expect(mocks.listDatabases).toHaveBeenCalledWith("mysql-b"));
    await nextTick();
    capacity();
    await vi.waitFor(() => expect(host.textContent).toContain("1.00 KB"));
    oldSize.resolve([{ name: "app", size_bytes: 999999 }]);
    await nextTick();
    await nextTick();
    expect(host.textContent).toContain("1.00 KB");
    expect(host.textContent).not.toContain("976.56");
    expect(mocks.listDatabaseStorage).toHaveBeenLastCalledWith("mysql-b", ["app"]);
  });

  it("keeps names on failure, reports it, and permits retry", async () => {
    mocks.listDatabaseStorage.mockRejectedValueOnce(new Error("capacity unavailable"));
    await mount();
    capacity();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(host.textContent).toContain("app");
    capacity();
    await vi.waitFor(() => expect(host.textContent).toContain("1.00 KB"));
    expect(mocks.listDatabaseStorage).toHaveBeenCalledTimes(2);
  });
});
