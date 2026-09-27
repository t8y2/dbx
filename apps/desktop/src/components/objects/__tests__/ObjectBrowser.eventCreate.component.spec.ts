// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig, ObjectInfo } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  ensureConnected: vi.fn(),
  editorInstances: 0,
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: () => connection,
    orderByPinnedTreeNodes: (rows: unknown[]) => rows,
  }),
}));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({}) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      shortcuts: { refreshData: "F5" },
      objectBrowserViewMode: "grid",
      objectBrowserShowCheckbox: false,
    },
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install: () => undefined } }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("vue-virtual-scroller", () => ({ RecycleScroller: { render: () => null } }));
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: { render: () => null } }));
vi.mock("@/components/ui/ToolbarOverflowMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/ui/CustomContextMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/MySqlEventEditor.vue", () => ({
  default: defineComponent({
    props: { name: String },
    emits: ["close", "saved"],
    setup(props, { emit }) {
      const draft = ref("");
      const instance = ++mocks.editorInstances;
      return () =>
        h("section", { "data-event-editor": props.name ?? "create", "data-instance": instance }, [
          h("input", {
            "data-event-draft": "",
            value: draft.value,
            onInput: (event: Event) => (draft.value = (event.target as HTMLInputElement).value),
          }),
          h("button", { "data-close-event": "", onClick: () => emit("close") }, "close"),
        ]);
    },
  }),
}));

const connection = {
  id: "mysql-events",
  name: "MySQL",
  db_type: "mysql",
  database: "app",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listObjects.mockResolvedValue([]);
  mocks.listSchemas.mockResolvedValue([]);
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.editorInstances = 0;
  invalidateObjectBrowserRowsCache({});
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
});

async function mountBrowser(overrides: Partial<InstanceType<typeof ObjectBrowser>["$props"]> = {}) {
  const props = reactive({ connection, database: "app", initialEventCreateRequestId: 1 as number | undefined, ...overrides });
  const browser = ref<InstanceType<typeof ObjectBrowser> | null>(null);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { ...props, ref: browser }) });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledOnce());
  await nextTick();
  return { browser, host, props };
}

describe("ObjectBrowser event editor rendering", () => {
  it("renders the first event CREATE editor when the database has no objects", async () => {
    const { host } = await mountBrowser();

    expect(host.querySelector('[data-event-editor="create"]')).not.toBeNull();
    expect(host.textContent).not.toContain("objects.empty");
  });

  it("keeps the ordinary empty state when no editor was requested", async () => {
    const { host } = await mountBrowser({ initialEventCreateRequestId: undefined });

    expect(host.textContent).toContain("objects.empty");
    expect(host.querySelector("[data-event-editor]")).toBeNull();
  });

  it("returns to the empty state after closing the CREATE editor", async () => {
    const { host } = await mountBrowser();
    const closeButton = host.querySelector<HTMLButtonElement>("[data-close-event]");
    expect(closeButton).not.toBeNull();
    closeButton!.click();
    await nextTick();

    expect(host.querySelector("[data-event-editor]")).toBeNull();
    expect(host.textContent).toContain("objects.empty");
  });

  it("remounts a fresh CREATE editor for another request on the empty tab", async () => {
    const { host, props } = await mountBrowser();
    const draft = host.querySelector<HTMLInputElement>("[data-event-draft]");
    expect(draft).not.toBeNull();
    draft!.value = "unsaved event";
    draft!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    const firstInstance = host.querySelector("[data-event-editor]")?.getAttribute("data-instance");

    props.initialEventCreateRequestId = 2;
    await nextTick();

    expect(host.querySelector("[data-event-editor]")?.getAttribute("data-instance")).not.toBe(firstInstance);
    expect(host.querySelector<HTMLInputElement>("[data-event-draft]")?.value).toBe("");
    expect(mocks.listObjects).toHaveBeenCalledOnce();
  });

  it("does not hide CREATE when an existing event is filtered out", async () => {
    mocks.listObjects.mockResolvedValue([{ name: "existing_event", schema: "app", object_type: "EVENT" }]);
    const { host } = await mountBrowser({ initialSearchQuery: "no-match" });

    expect(host.querySelector('[data-event-editor="create"]')).not.toBeNull();
    expect(host.textContent).not.toContain("objects.empty");
  });

  it("still opens an existing event in edit mode", async () => {
    mocks.listObjects.mockResolvedValue([{ name: "existing_event", schema: "app", object_type: "EVENT" }]);
    const { host } = await mountBrowser({ initialEventCreateRequestId: undefined, initialEventName: "existing_event", initialEventOpenRequestId: 1 });

    expect(host.querySelector('[data-event-editor="existing_event"]')).not.toBeNull();
  });

  it("keeps loading visible until the initial object request completes", async () => {
    let resolveObjects!: (objects: ObjectInfo[]) => void;
    mocks.listObjects.mockImplementation(() => new Promise<ObjectInfo[]>((resolve) => (resolveObjects = resolve)));
    const { host } = await mountBrowser();

    expect(host.textContent).toContain("objects.loading");
    expect(host.querySelector("[data-event-editor]")).toBeNull();

    resolveObjects([]);
    await vi.waitFor(() => expect(host.querySelector('[data-event-editor="create"]')).not.toBeNull());
  });

  it("preserves an object-load failure instead of hiding it with the editor", async () => {
    mocks.listObjects.mockRejectedValue(new Error("objects unavailable"));
    const { host } = await mountBrowser();

    expect(host.textContent).toContain("objects unavailable");
    expect(host.querySelector("[data-event-editor]")).toBeNull();
  });
});

describe("ObjectBrowser refresh scope", () => {
  it("matches the schema selected automatically by loadSchemas", async () => {
    mocks.listSchemas.mockResolvedValue(["APP", "OTHER"]);
    const damengConnection = { ...connection, id: "dameng", name: "Dameng", db_type: "dameng" } as ConnectionConfig;
    const { browser } = await mountBrowser({ connection: damengConnection, initialEventCreateRequestId: undefined });

    expect(browser.value?.matchesRefreshScope({ schema: "APP" })).toBe(true);
    expect(browser.value?.matchesRefreshScope({ schema: "OTHER" })).toBe(false);
    expect(browser.value?.matchesRefreshScope({ schema: "APP", catalog: "OTHER" })).toBe(false);
  });
});
