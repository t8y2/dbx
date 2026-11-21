// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { QueryResult } from "@/types/database";

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
import { useSettingsStore } from "@/stores/settingsStore";

const prefix = "long-value-prefix-".repeat(30);
const alpha = `${prefix}ALPHA_END`;
const beta = `${prefix}BETA_END`;
const mounted: Array<{ app: App; host: HTMLElement }> = [];

async function settle() {
  for (let i = 0; i < 6; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

async function openFilter() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSettingsStore().updateEditorSettings({ dataGridRenderMode: "canvas", compactColumnHeaderActions: false });
  const result = markRaw<QueryResult>({ columns: ["label"], column_types: ["varchar"], rows: [[beta], [alpha]], affected_rows: 2, execution_time_ms: 1 });
  const onLocalColumnFiltersChange = vi.fn();
  const Root = defineComponent({
    setup: () => () => h(TooltipProvider, { delayDuration: 0 }, { default: () => h(DataGrid, { result, databaseType: "mysql", context: "table-data", onLocalColumnFiltersChange }) }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });
  await settle();
  const trigger = host.querySelector<HTMLButtonElement>(`button[title="${i18n.global.t("grid.localFilter")}"]`)!;
  expect(trigger).toBeTruthy();
  trigger.click();
  await settle();
  return { onLocalColumnFiltersChange };
}

function valueButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((button) => button.textContent?.includes("long-value-prefix-"));
}

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DataGrid local filter full values", () => {
  it("keeps distinct suffixes in sorted option labels beyond the grid display limit", async () => {
    await openFilter();
    expect(valueButtons().map((button) => button.textContent)).toEqual([`${alpha}1`, `${beta}1`]);
  });

  it("finds an actual candidate when searching for its suffix beyond the display limit", async () => {
    await openFilter();
    const search = document.querySelector<HTMLInputElement>(`input[placeholder="${i18n.global.t("grid.searchValues")}"]`)!;
    search.value = "BETA_END";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(valueButtons()).toHaveLength(1);
    expect(valueButtons()[0].textContent).toBe(`${beta}1`);
  });

  it("filters with the original full value after changing the selected candidate", async () => {
    const { onLocalColumnFiltersChange } = await openFilter();
    const alphaButton = valueButtons().find((button) => button.textContent?.includes("ALPHA_END")) ?? valueButtons()[1];
    alphaButton.click();
    await settle();
    const apply = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === i18n.global.t("grid.applyFilter"))!;
    apply.click();
    await settle();
    expect(onLocalColumnFiltersChange).toHaveBeenLastCalledWith({ "0": [`str:${beta}`] });
  });

  it.each(["hover", "focus"] as const)("exposes the full formatted candidate on %s", async (interaction) => {
    await openFilter();
    const button = valueButtons()[0];
    vi.useFakeTimers();
    vi.spyOn(button, "matches").mockImplementation((selector) => selector === (interaction === "hover" ? ":hover" : ":focus-visible"));
    if (interaction === "hover") button.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    else button.focus();
    await vi.advanceTimersByTimeAsync(350);
    await settle();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(alpha);
  });
});
