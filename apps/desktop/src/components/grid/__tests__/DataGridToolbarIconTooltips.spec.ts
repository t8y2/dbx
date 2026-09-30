// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/composables/useDataGridColumnResize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDataGridColumnResize")>();
  const { ref } = await import("vue");
  return {
    ...actual,
    useDataGridColumnResize: () => ({
      initColumnWidths: vi.fn(),
      onResizeStart: vi.fn(),
      autoFitColumn: vi.fn(),
      renderedColumnWidths: ref([120]),
      totalWidth: ref(120),
      columnVars: ref({ "--total-w": "120px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import DataGridToolbar from "../DataGridToolbar.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

const RecycleScroller = defineComponent({
  props: {
    items: {
      type: Array as PropType<unknown[]>,
      default: () => [],
    },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        "div",
        attrs,
        props.items.map((item) => slots.default?.({ item })),
      );
  },
});

function mountWithProvider(render: () => ReturnType<typeof h>) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const host = document.createElement("div");
  document.body.append(host);
  const Root = defineComponent({
    setup() {
      return () => h(TooltipProvider, { delayDuration: 0 }, { default: render });
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.component("RecycleScroller", RecycleScroller);
  app.mount(host);
  const mounted = { app, host };
  mountedApps.push(mounted);
  return mounted;
}

function mountToolbar() {
  return mountWithProvider(() =>
    h(DataGridToolbar, {
      compact: true,
      refresh: { label: "Refresh", tooltip: "Refresh (Mod+R)", onTrigger: vi.fn() },
      autoRefresh: {
        label: "Auto-refresh results",
        shortLabel: "Auto",
        startLabel: "Start auto-refresh",
        stopLabel: "Stop auto-refresh",
        enabled: false,
        intervalSeconds: 30,
        sweepKey: 0,
        intervalOptions: [10, 30, 60],
        intervalLabel: (seconds: number) => `Refresh every ${seconds}s`,
        onToggle: vi.fn(),
        onSelectInterval: vi.fn(),
      },
      exportData: {
        label: "Export",
        items: [{ value: "csv", label: "CSV" }],
        onSelect: vi.fn(),
      },
    }),
  );
}

function mountGrid() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    shortcuts: { ...settingsStore.editorSettings.shortcuts, goToColumn: "Mod+G" },
  });
  const result = markRaw<QueryResult>({
    columns: ["id"],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 0,
  });
  const host = document.createElement("div");
  document.body.append(host);
  const Root = defineComponent({
    setup() {
      return () => h(TooltipProvider, { delayDuration: 0 }, { default: () => h(DataGrid, { result, databaseType: "mysql", context: "table-data" }) });
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.component("RecycleScroller", RecycleScroller);
  app.mount(host);
  const mounted = { app, host };
  mountedApps.push(mounted);
  return mounted;
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await nextTick();
}

function toolbarButton(host: HTMLElement, action: string): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`[data-toolbar-action="${action}"]`);
  if (!button) throw new Error(`Toolbar button ${action} not found`);
  return button;
}

function visibleTooltipTexts(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="tooltip-content"]')].map((element) => element.textContent?.trim() ?? "");
}

function showsTooltip(text: string): boolean {
  return visibleTooltipTexts().some((candidate) => candidate.includes(text));
}

async function hover(element: HTMLElement) {
  element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerType: "mouse" }));
  await settle();
}

async function click(element: HTMLElement) {
  element.click();
  await settle();
}

function expectPositionedSurface(contentType: string) {
  const content = document.querySelector<HTMLElement>(`[data-slot="${contentType}"]`);
  if (!content) throw new Error(`No ${contentType} surface was rendered`);
  const wrapper = content.parentElement;
  if (!wrapper) throw new Error(`No ${contentType} popper wrapper was rendered`);
  // Reka parks an unpositioned surface at `translate(0, -200%)`, which puts every
  // menu and popover above the viewport.
  expect(wrapper.style.transform).toMatch(/^translate\(-?[\d.]+px, -?[\d.]+px\)$/);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  document.body.innerHTML = "";
});

describe("data grid icon-only toolbar tooltips", () => {
  it("keeps the existing refresh tooltip (control case)", async () => {
    const { host } = mountToolbar();
    await settle();

    const button = toolbarButton(host, "refresh");
    await hover(button);

    expect(showsTooltip("Refresh (Mod+R)")).toBe(true);
  });

  it("shows a tooltip for the auto refresh control", async () => {
    const { host } = mountToolbar();
    await settle();

    const button = toolbarButton(host, "autoRefresh");
    await hover(button);

    expect(showsTooltip("Auto-refresh results")).toBe(true);
  });

  it("shows a tooltip for the go to column control", async () => {
    const { host } = mountGrid();
    await settle();

    const button = toolbarButton(host, "navigation");
    await hover(button);

    expect(showsTooltip("Go to column")).toBe(true);
  });
});

// Reka resolves the popper anchor from the nearest popper root. Wrapping an overlay
// trigger in TooltipTrigger handed the anchor to the tooltip root instead, so the
// menu/popover still opened but kept the unpositioned `translate(0, -200%)`
// fallback and every toolbar click looked like a no-op.
describe("data grid toolbar overlay surfaces anchor to their trigger", () => {
  it("positions the auto refresh menu after a click", async () => {
    const { host } = mountToolbar();
    await settle();

    await click(toolbarButton(host, "autoRefresh"));

    expectPositionedSurface("dropdown-menu-content");
  });

  it("positions the export menu after a click", async () => {
    const { host } = mountToolbar();
    await settle();

    await click(toolbarButton(host, "exportData"));

    expectPositionedSurface("dropdown-menu-content");
  });

  it("positions the go to column popover after a click", async () => {
    const { host } = mountGrid();
    await settle();

    await click(toolbarButton(host, "navigation"));

    expectPositionedSurface("popover-content");
  });
});
