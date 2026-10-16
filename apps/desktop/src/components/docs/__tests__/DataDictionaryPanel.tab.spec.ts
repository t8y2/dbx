// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataDictionaryPanel from "@/components/docs/DataDictionaryPanel.vue";
import type { DataDictionaryTabState } from "@/types/database";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listDatabases: vi.fn().mockResolvedValue([{ name: "shop" }]),
  listSchemas: vi.fn().mockResolvedValue(["public"]),
  listTables: vi.fn().mockResolvedValue([{ name: "orders", table_type: "TABLE", parent_schema: "public" }]),
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [{ id: "conn-1", name: "MySQL", db_type: "mysql", driver_profile: "mysql" }],
    getConfig: (id: string) => (id === "conn-1" ? { id, name: "MySQL", db_type: "mysql", driver_profile: "mysql" } : undefined),
    ensureConnected: mocks.ensureConnected,
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  listSchemas: mocks.listSchemas,
  listTables: mocks.listTables,
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function dictionarySnapshot(): DataDictionaryTabState {
  return {
    config: { connectionId: "conn-1", database: "shop", schema: "public" },
    profile: {
      version: 1,
      databases: ["shop"],
      schemas: [{ database: "shop", name: "public" }],
      objects: [{ database: "shop", schema: "public", name: "orders" }],
      layout: {
        templateId: "standard",
        title: "shop",
        subtitle: "",
        header: "",
        remarks: "",
        introduction: "",
        detailedIntroduction: "",
        leftFooter: "shop",
        coverFooter: "",
        includeCover: true,
        includeToc: true,
        includeBreadcrumbs: true,
        includeLeftFooter: true,
        includePageNumber: true,
        includeIntroduction: true,
        includeIndexes: false,
        includeIndexesAndForeignKeys: true,
        paper: "A4",
        orientation: "portrait",
        marginCm: 1.5,
        headingSize: 16,
        bodySize: 9,
      },
      appendTimestamp: false,
      overwrite: true,
      continueOnError: true,
      fileName: "",
    },
    step: 2,
  };
}

const mountedApps: App[] = [];
const emitted: Record<string, unknown[]> = {};

async function flushAsyncSetup() {
  for (let index = 0; index < 10; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function mountTabPanel() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(DataDictionaryPanel, {
            inDialog: false,
            initialState: dictionarySnapshot(),
            onConvertToDialog: (state: unknown) => (emitted["convert-to-dialog"] = [state]),
          });
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.use(createPinia());
  app.mount(container);
  return app;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  for (const key of Object.keys(emitted)) delete emitted[key];
});

describe("DataDictionaryPanel tab form factor", () => {
  it("restores the wizard step and selections from the snapshot (conversion is owned by the tab pill)", async () => {
    installLocalStorage();
    mountTabPanel();
    await vi.waitFor(() => {
      // The profile's step 2 is restored: the template step is active.
      expect(document.body.textContent).toContain(i18n.global.t("dataDictionary.stepTemplate"));
    });
    await flushAsyncSetup();

    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.includes(i18n.global.t("workspace.convertToDialog")))).toBe(false);
  }, 30_000);
});
