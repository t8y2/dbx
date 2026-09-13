// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, onBeforeUnmount, type App, type Component } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DataView, DataViewSummary } from "@/types/dataView";

interface CtxItem {
  label: string;
  action?: () => void;
  variant?: string;
  separator?: boolean;
}

const { ctxRegistry, seed, toastSpy } = vi.hoisted(() => ({
  ctxRegistry: [] as Array<{ getItems: () => CtxItem[] }>,
  seed: { summaries: [] as DataViewSummary[], views: [] as DataView[] },
  toastSpy: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function passthrough(tag = "div") {
  return defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => h(tag, attrs, [slots.default?.()]);
    },
  });
}

vi.mock("@lucide/vue", () => {
  const icon = defineComponent({ setup: () => () => h("i") });
  return {
    ChevronLeft: icon,
    Download: icon,
    LayoutDashboard: icon,
    Loader2: icon,
    Pencil: icon,
    Play: icon,
    Plus: icon,
    RefreshCw: icon,
    Search: icon,
    Share2: icon,
    Trash2: icon,
    Upload: icon,
    X: icon,
  };
});

vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/LightTooltip.vue", () => ({ default: passthrough("span") }));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: defineComponent({
    props: { open: { type: Boolean, default: false } },
    emits: ["update:open"],
    setup(props, { slots }) {
      return () => (props.open ? h("div", { "data-dbx-dialog": "" }, [slots.default?.()]) : null);
    },
  }),
  DialogContent: passthrough("div"),
  DialogDescription: passthrough("p"),
  DialogFooter: passthrough("div"),
  DialogHeader: passthrough("div"),
  DialogTitle: passthrough("h2"),
}));

vi.mock("@/components/ui/CustomContextMenu.vue", () => ({
  default: defineComponent({
    props: { items: { type: [Array, Function], required: true } },
    setup(props, { slots }) {
      const entry = { getItems: () => (typeof props.items === "function" ? props.items() : props.items) };
      ctxRegistry.push(entry);
      onBeforeUnmount(() => {
        const index = ctxRegistry.indexOf(entry);
        if (index >= 0) ctxRegistry.splice(index, 1);
      });
      return () => h("div", { "data-dbx-ctx-row": "" }, [slots.default?.({ onContextMenu: () => undefined, isOpen: false })]);
    },
  }),
}));

vi.mock("@/components/dataView/DataViewRunner.vue", () => ({
  default: defineComponent({ props: { view: { type: Object, required: true } }, setup: () => () => h("div", { "data-dbx-runner": "" }) }),
}));

vi.mock("@/components/dataView/DataViewEditor.vue", () => ({
  default: defineComponent({ props: { view: { type: Object, required: true } }, setup: () => () => h("div", { "data-dbx-editor": "" }) }),
}));

vi.mock("@/lib/backend/api", () => ({
  listDataViews: vi.fn(async () => seed.summaries),
  loadDataView: vi.fn(async (id: string) => seed.views.find((view) => view.id === id) ?? null),
  saveDataView: vi.fn(async (view: unknown) => view),
  deleteDataView: vi.fn(async () => undefined),
  executeDataView: vi.fn(async () => ({ results: [] })),
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: toastSpy }) }));

vi.mock("@/lib/dataView/dataViewShareLink", () => ({ dataViewShareUrl: (id: string) => `https://share.example/data-view/${id}` }));

import * as api from "@/lib/backend/api";
import { useDataViewStore } from "@/stores/dataViewStore";
import DataViewPage from "../DataViewPage.vue";

function makeSummary(overrides: Partial<DataViewSummary> = {}): DataViewSummary {
  return {
    id: "view-1",
    name: "View Alpha",
    description: "Monthly revenue by region",
    defaultDisplayMode: "table",
    queryCount: 2,
    ownerId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeView(id: string): DataView {
  return {
    id,
    name: "View Alpha",
    description: "Monthly revenue by region",
    defaultDisplayMode: "table",
    queries: [],
    variables: [],
    ownerId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

async function mountPage(props: Record<string, unknown> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const host = document.createElement("div");
  document.body.append(host);
  const wrapper: Component = defineComponent({
    setup() {
      return () => h(DataViewPage, props);
    },
  });
  const app = createApp(wrapper);
  app.use(pinia);
  app.mount(host);
  mountedApps.push({ app, host });
  await flush();
  return host;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await nextTick();
}

function findButtonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find((candidate) => (candidate.textContent ?? "").includes(text));
  if (!button) throw new Error(`button with text ${text} not found`);
  return button;
}

beforeEach(() => {
  seed.summaries = [];
  seed.views = [];
  ctxRegistry.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataViewPage list screen", () => {
  it("renders one row per summary with name, query count, and header count", async () => {
    seed.summaries = [makeSummary(), makeSummary({ id: "view-2", name: "View Beta" })];
    const host = await mountPage();
    await vi.waitFor(() => expect(host.querySelectorAll("[data-dbx-ctx-row]").length).toBe(2));
    expect(host.textContent).toContain("View Alpha");
    expect(host.textContent).toContain("View Beta");
    expect(host.textContent).toContain("dataView.title");
    expect(host.textContent).toContain("(2)");
    expect(host.textContent).toContain("2 dataView.queries");
  });

  it("filters rows by the search box and clears with the X button", async () => {
    seed.summaries = [makeSummary(), makeSummary({ id: "view-2", name: "View Beta", description: null })];
    const host = await mountPage();
    await vi.waitFor(() => expect(host.querySelectorAll("[data-dbx-ctx-row]").length).toBe(2));

    const input = host.querySelector("input[type='text']") as HTMLInputElement;
    expect(input.placeholder).toBe("dataView.search");
    input.value = "beta";
    input.dispatchEvent(new Event("input"));
    await flush();
    expect(host.querySelectorAll("[data-dbx-ctx-row]").length).toBe(1);
    expect(host.textContent).toContain("View Beta");
    expect(host.textContent).not.toContain("View Alpha");
    expect(host.textContent).toContain("(1)");

    const clearButton = host.querySelector("button[aria-label='dataView.search']") as HTMLButtonElement;
    expect(clearButton).toBeTruthy();
    clearButton.click();
    await flush();
    expect(host.querySelectorAll("[data-dbx-ctx-row]").length).toBe(2);
  });

  it("shows the no-search-results hint when the filter matches nothing", async () => {
    seed.summaries = [makeSummary()];
    const host = await mountPage();
    await vi.waitFor(() => expect(host.querySelectorAll("[data-dbx-ctx-row]").length).toBe(1));

    const input = host.querySelector("input[type='text']") as HTMLInputElement;
    input.value = "zzz-no-match";
    input.dispatchEvent(new Event("input"));
    await flush();
    expect(host.textContent).toContain("dataView.noSearchResults");
    expect(host.querySelectorAll("[data-dbx-ctx-row]").length).toBe(0);
  });

  it("shows the empty state with a create CTA and opens the editor on click", async () => {
    const host = await mountPage();
    await vi.waitFor(() => expect(host.textContent).toContain("dataView.emptyListHint"));
    expect(host.querySelectorAll("[data-dbx-ctx-row]").length).toBe(0);

    findButtonByText(host, "dataView.newView").click();
    await flush();
    expect(host.querySelector("[data-dbx-editor]")).toBeTruthy();
  });

  it("opens the editor directly when an openRequest with mode editor is provided", async () => {
    seed.summaries = [makeSummary()];
    seed.views = [makeView("view-1")];
    const host = await mountPage({ openRequest: { id: "view-1", mode: "editor", token: 1 } });
    await vi.waitFor(() => expect(host.querySelector("[data-dbx-editor]")).toBeTruthy());
    expect(api.loadDataView).toHaveBeenCalledWith("view-1");
  });

  it("deletes a view through the confirmation dialog and the store", async () => {
    seed.summaries = [makeSummary(), makeSummary({ id: "view-2", name: "View Beta" })];
    const host = await mountPage();
    await vi.waitFor(() => expect(host.querySelectorAll("[data-dbx-ctx-row]").length).toBe(2));

    const entry = ctxRegistry.find((candidate) => candidate.getItems().some((item) => item.label === "dataView.delete"));
    expect(entry).toBeTruthy();
    const deleteItem = entry!.getItems().find((item) => item.label === "dataView.delete");
    expect(deleteItem?.variant).toBe("destructive");
    deleteItem!.action!();
    await flush();

    const dialog = host.querySelector("[data-dbx-dialog]");
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("dataView.confirmDelete");
    expect(dialog!.textContent).toContain("dataView.confirmDeleteMessage");

    findButtonByText(dialog!, "dataView.delete").click();
    await vi.waitFor(() => expect(api.deleteDataView).toHaveBeenCalledWith("view-1"));
    await flush();

    expect(host.querySelector("[data-dbx-dialog]")).toBeNull();
    const store = useDataViewStore();
    expect(store.summaries.map((s) => s.id)).toEqual(["view-2"]);
    expect(host.textContent).toContain("View Beta");
    expect(host.textContent).not.toContain("View Alpha");
  });
});
