// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, ref, type App, type PropType } from "vue";
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
      renderedColumnWidths: ref([100, 100, 100, 100]),
      totalWidth: ref(400),
      columnVars: ref({ "--total-w": "400px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
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

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("DataGrid revealColumnRequest", () => {
  it("reveals and highlights column matching revealColumnRequest", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const settingsStore = useSettingsStore();
    settingsStore.updateEditorSettings({
      dataGridRenderMode: "canvas",
    });

    const columns = ["id", "username", "email", "created_at"];
    const result = markRaw<QueryResult>({
      columns,
      rows: [[1, "alice", "alice@example.com", "2026-01-01"]],
      affected_rows: 0,
      execution_time_ms: 0,
    });

    const revealRequest = ref<{ id: number; columnName: string } | undefined>({
      id: 1,
      columnName: "email",
    });

    const host = document.createElement("div");
    document.body.append(host);

    const Root = defineComponent({
      setup() {
        return () =>
          h(
            TooltipProvider,
            { delayDuration: 0 },
            {
              default: () =>
                h(DataGrid, {
                  result,
                  databaseType: "mysql",
                  context: "table-data",
                  revealColumnRequest: revealRequest.value,
                }),
            },
          );
      },
    });

    const app = createApp(Root);
    app.use(pinia);
    app.use(i18n);
    app.component("RecycleScroller", RecycleScroller);
    app.mount(host);
    mountedApps.push({ app, host });

    await nextTick();
    await nextTick();

    const emailHeader = host.querySelector('[data-grid-column-index="2"]');
    expect(emailHeader).toBeTruthy();
    expect(emailHeader?.classList.contains("data-grid-header-cell--selected")).toBe(true);
  });

  it("updates reveal when revealColumnRequest prop changes with new id", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const settingsStore = useSettingsStore();
    settingsStore.updateEditorSettings({
      dataGridRenderMode: "canvas",
    });

    const columns = ["id", "username", "email", "created_at"];
    const result = markRaw<QueryResult>({
      columns,
      rows: [[1, "alice", "alice@example.com", "2026-01-01"]],
      affected_rows: 0,
      execution_time_ms: 0,
    });

    const revealRequest = ref<{ id: number; columnName: string } | undefined>(undefined);

    const host = document.createElement("div");
    document.body.append(host);

    const Root = defineComponent({
      setup() {
        return () =>
          h(
            TooltipProvider,
            { delayDuration: 0 },
            {
              default: () =>
                h(DataGrid, {
                  result,
                  databaseType: "mysql",
                  context: "table-data",
                  revealColumnRequest: revealRequest.value,
                }),
            },
          );
      },
    });

    const app = createApp(Root);
    app.use(pinia);
    app.use(i18n);
    app.component("RecycleScroller", RecycleScroller);
    app.mount(host);
    mountedApps.push({ app, host });

    await nextTick();

    // Trigger reveal request
    revealRequest.value = { id: 2, columnName: "created_at" };
    await nextTick();
    await nextTick();

    const createdAtHeader = host.querySelector('[data-grid-column-index="3"]');
    expect(createdAtHeader).toBeTruthy();
    expect(createdAtHeader?.classList.contains("data-grid-header-cell--selected")).toBe(true);
  });
});
