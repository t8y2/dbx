// @vitest-environment happy-dom

import { createApp, defineComponent, h, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DatabaseDocsPanel from "@/components/docs/DatabaseDocsPanel.vue";
import type { DatabaseDocsTabState } from "@/types/database";

const mocks = vi.hoisted(() => ({
  collectDocsSnapshot: vi.fn(),
  loadDocsAnnotations: vi.fn().mockResolvedValue(null),
  applyDocsAnnotations: vi.fn(),
  saveDocsAnnotations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [{ id: "conn-1", name: "MySQL", db_type: "mysql", driver_profile: "mysql" }],
    getConfig: () => ({ id: "conn-1", name: "MySQL", db_type: "mysql", driver_profile: "mysql" }),
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    diagramSource: null,
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  collectDocsSnapshot: mocks.collectDocsSnapshot,
  loadDocsAnnotations: mocks.loadDocsAnnotations,
  applyDocsAnnotations: mocks.applyDocsAnnotations,
  saveDocsAnnotations: mocks.saveDocsAnnotations,
}));

// The docs viewer is a large standalone app; the panel contract under test is
// the session wiring, not the viewer rendering.
vi.mock("@/docs/DocsApp.vue", () => ({
  default: {
    name: "DocsAppStub",
    props: { snapshot: { type: Object, required: true } },
    render(this: { snapshot?: { project?: { name?: string } } }) {
      return h("div", { "data-docs-app": true }, String(this.snapshot?.project?.name ?? ""));
    },
  },
}));

vi.mock("@/components/docs/DataDictionaryDialog.vue", () => ({
  default: { name: "DataDictionaryDialogStub", render: () => h("div") },
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function docsSnapshot(): DatabaseDocsTabState {
  return { config: { connectionId: "conn-1", database: "shop", schema: "public" } };
}

const mountedApps: App[] = [];
const emitted: Record<string, unknown[]> = {};

function mountTabPanel() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(DatabaseDocsPanel, {
            inDialog: false,
            initialState: docsSnapshot(),
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

describe("DatabaseDocsPanel tab form factor", () => {
  it("loads the docs session outside the component, survives remounts, and emits config on convert", async () => {
    installLocalStorage();
    mocks.collectDocsSnapshot.mockResolvedValue({ project: { name: "shop-docs" }, tables: [], warnings: [] });
    mocks.applyDocsAnnotations.mockResolvedValue({ project: { name: "shop-docs" }, tables: [], warnings: [] });

    const first = mountTabPanel();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-docs-app]")).not.toBeNull();
    });
    expect(mocks.collectDocsSnapshot).toHaveBeenCalledTimes(1);

    // Session outlives the panel: a remount re-attaches it instead of re-collecting.
    first.unmount();
    mountedApps.splice(mountedApps.indexOf(first), 1);
    document.body.textContent = "";
    mountTabPanel();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-docs-app]")).not.toBeNull();
    });
    expect(mocks.collectDocsSnapshot).toHaveBeenCalledTimes(1);

    // Conversion is owned by the tab pill (EditorGroupTabBar.dialogBack.spec).
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.includes(i18n.global.t("workspace.convertToDialog")))).toBe(false);
  }, 30_000);
});
