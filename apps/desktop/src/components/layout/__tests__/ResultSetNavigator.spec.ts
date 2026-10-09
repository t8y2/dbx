// @vitest-environment happy-dom
import { createApp, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResultSetNavigator from "../ResultSetNavigator.vue";
import { tabularResultItems } from "@/lib/tabs/tabPresentation";
import type { QueryResult } from "@/types/database";

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  document.body.replaceChildren();
});

async function mountNavigator(inputResults?: QueryResult[], canExportXlsx = true, displayMode: "tabs" | "list" = "tabs", activeIndex = 1) {
  // Include a non-tabular result so ordinal and storage index are different.
  const results = inputResults ?? ([{ columns: [], rows: [] }, ...Array.from({ length: 100 }, (_, i) => ({ columns: ["value"], rows: [[i + 1]], sourceStatement: `SELECT ${i + 1} AS value` }))] as QueryResult[]);
  const select = vi.fn();
  const copySql = vi.fn();
  const copyQuerySql = vi.fn();
  const exportXlsx = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  app = createApp(ResultSetNavigator, { items: tabularResultItems(results), activeIndex, active: true, canExportXlsx, displayMode, onSelect: select, onCopySql: copySql, onCopyQuerySql: copyQuerySql, onExportXlsx: exportXlsx });
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          tabs: {
            resultN: "Result {n}",
            resultSets: "Result sets",
            allResults: "All results ({count})",
            searchResults: "Search",
            noMatchingResults: "No matches",
            batchResultActions: "Batch actions",
            batchSelectedCount: "{count}/{total} selected",
            selectAllResults: "Select all",
            clearResultSelection: "Clear",
            copyResultQueries: "Copy queries",
            copyResultAsSql: "Copy as SQL",
            exportSelectedResultsXlsx: "Export XLSX",
            batchLoadedRowsOnly: "Uses loaded rows",
            batchIncompleteResult: "Incomplete",
          },
        },
      },
    }),
  );
  app.mount(container);
  await nextTick();
  return { container, select, copySql, copyQuerySql, exportXlsx };
}

async function openBatchMenu(container: HTMLElement) {
  [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Batch actions"))!.click();
  await nextTick();
  await nextTick();
  const popup = [...document.querySelectorAll<HTMLElement>('[data-slot="popover-content"]')].find((candidate) => candidate.textContent?.includes("Batch actions"))!;
  const input = popup.querySelector<HTMLInputElement>('input[type="search"]')!;
  const filter = async (query: string) => {
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
  };
  return { popup, input, filter };
}

describe("large result-set navigation", () => {
  it("renders three data sets rather than five tabs when messages are interleaved", async () => {
    const message: QueryResult = { columns: ["Message"], rows: [["notice"]], affected_rows: 0, execution_time_ms: 1, server_message: true };
    const data: QueryResult = { columns: ["Message"], rows: [["real data"]], affected_rows: 0, execution_time_ms: 1 };
    const { container, select } = await mountNavigator([message, data, message, { ...data, rows: [] }, data]);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".result-set-scroll button")];

    expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Result 1", "Result 2", "Result 3"]);
    expect(container.textContent).toContain("All results (3)");
    buttons[1]?.click();
    expect(select.mock.calls[0]?.[0]).toMatchObject({ index: 3, n: 2 });
  });

  it("scrolls the result-set strip with a vertical wheel and consumes boundary gestures", async () => {
    const { container } = await mountNavigator();
    const strip = container.querySelector<HTMLElement>(".result-set-scroll")!;
    Object.defineProperties(strip, { clientWidth: { value: 400 }, scrollWidth: { value: 8000 } });
    const wheel = new WheelEvent("wheel", { deltaY: 200, bubbles: true, cancelable: true });
    strip.dispatchEvent(wheel);
    expect(strip.scrollLeft).toBe(200);
    expect(wheel.defaultPrevented).toBe(true);
    strip.scrollLeft = 7600;
    const boundary = new WheelEvent("wheel", { deltaY: 200, bubbles: true, cancelable: true });
    strip.dispatchEvent(boundary);
    expect(strip.scrollLeft).toBe(7600);
    expect(boundary.defaultPrevented).toBe(true);
  });

  it("finds an exact ordinal among 100 results and selects its original storage index", async () => {
    const { container, select } = await mountNavigator();
    const trigger = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("All results"))!;
    trigger.click();
    await nextTick();
    await nextTick();
    const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(input).toBeTruthy();
    input.value = "8";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    const popup = document.querySelector('[data-slot="popover-content"]')!;
    expect(popup.querySelectorAll("button")).toHaveLength(1);
    expect(popup.textContent).toContain("Result 8");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(select).toHaveBeenCalledOnce();
    expect(select.mock.calls[0]![0]).toMatchObject({ n: 8, index: 8 });
  });

  it("emits the selected result sets without changing the active result", async () => {
    const { container, copySql } = await mountNavigator([
      { columns: ["id"], rows: [[1]], sourceName: "first", sourceStatement: "SELECT 1" },
      { columns: ["id"], rows: [[2]], sourceName: "second", sourceStatement: "SELECT 2" },
    ]);
    const batchTrigger = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Batch actions"))!;
    batchTrigger.click();
    await nextTick();
    const action = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Copy as SQL"))!;
    action.click();
    await nextTick();
    expect(copySql).toHaveBeenCalledOnce();
    expect(copySql.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it.each([
    ["Copy as SQL", "copySql"],
    ["Copy queries", "copyQuerySql"],
    ["Export XLSX", "exportXlsx"],
  ] as const)("%s only includes selected results matching the batch search", async (action, event) => {
    const mounted = await mountNavigator([
      { columns: [], rows: [] },
      { columns: ["id"], rows: [[1]], sourceLabel: "apis", sourceStatement: "SELECT * FROM apis" },
      { columns: ["id"], rows: [[2]], sourceLabel: "menus", sourceStatement: "SELECT * FROM menus WHERE enabled = true" },
    ]);
    const { popup, filter } = await openBatchMenu(mounted.container);
    await filter("APIS");
    expect(popup.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(popup.textContent).toContain("2/2 selected");
    [...popup.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Clear")!.click();
    await nextTick();
    expect(popup.textContent).toContain("1/2 selected");
    await filter("enabled");
    expect(popup.querySelectorAll("label")[0]?.textContent).toContain("menus");
    [...popup.querySelectorAll("button")].find((button) => button.textContent?.includes(action))!.click();
    expect(mounted[event]).toHaveBeenCalledOnce();
    expect(mounted[event].mock.calls[0]?.[0].map((item: { index: number }) => item.index)).toEqual([2]);
    expect(mounted.select).not.toHaveBeenCalled();
  });

  it("disables XLSX export when the result view is inactive", async () => {
    const mounted = await mountNavigator(
      [
        { columns: ["id"], rows: [[1]], sourceStatement: "SELECT 1" },
        { columns: ["id"], rows: [[2]], sourceStatement: "SELECT 2" },
      ],
      false,
    );
    const { popup } = await openBatchMenu(mounted.container);
    const exportButton = [...popup.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Export XLSX"));

    expect(exportButton?.disabled).toBe(true);
  });

  it("selects and clears only visible results and restores hidden selections when the search is cleared", async () => {
    const { container } = await mountNavigator();
    const { popup, filter } = await openBatchMenu(container);
    await filter("8");
    expect(popup.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    const clear = [...popup.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Clear")!;
    const selectAll = [...popup.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Select all")!;
    clear.click();
    await nextTick();
    expect(popup.textContent).toContain("99/100 selected");
    await filter("");
    expect(popup.textContent).toContain("99/100 selected");
    await filter("8");
    selectAll.click();
    await nextTick();
    await filter("");
    expect(popup.textContent).toContain("100/100 selected");
    await filter("no matching result");
    expect(popup.querySelector('[role="status"]')?.textContent).toBe("No matches");
    expect([...popup.querySelectorAll("button")].filter((button) => button.textContent?.includes("Select all") || button.textContent?.includes("Clear")).every((button) => button.disabled)).toBe(true);
  });

  it("renders a dropdown selector instead of horizontal tabs when displayMode is list", async () => {
    const { container, select } = await mountNavigator(undefined, true, "list");
    expect(container.querySelector(".result-set-scroll")).toBeNull();
    const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Result 1"))!;
    expect(trigger).toBeTruthy();
    expect(trigger.querySelector("svg")).toBeTruthy();
    // No separate "All results (100)" button in list mode
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("All results"))).toBe(false);

    trigger.click();
    await nextTick();
    await nextTick();
    const popup = document.querySelector('[data-slot="popover-content"]')!;
    expect(popup).toBeTruthy();
    const itemButton = [...popup.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Result 5"))!;
    expect(itemButton).toBeTruthy();
    itemButton.click();
    expect(select).toHaveBeenCalledOnce();
    expect(select.mock.calls[0]![0]).toMatchObject({ n: 5, index: 5 });
  });

  it("renders a single result item without dropdown chevron in list mode when there is only one result", async () => {
    const single: QueryResult = { columns: ["id"], rows: [[1]], sourceStatement: "SELECT 1" };
    const { container } = await mountNavigator([single], true, "list", 0);
    expect(container.querySelector(".result-set-scroll")).toBeNull();
    const button = container.querySelector<HTMLButtonElement>("button")!;
    expect(button.textContent?.trim()).toBe("Result 1");
    // No dropdown chevron
    expect(button.querySelector("svg")).toBeNull();
  });

  it("falls back to the generic label in list mode when the active result is a filtered-out message", async () => {
    // activeIndex 0 is the storage index of the non-tabular server message.
    const { container } = await mountNavigator(undefined, true, "list", 0);
    const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Result sets"))!;
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).not.toContain("Result 1");
    // The dropdown stays usable and batch actions remain reachable.
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Batch actions"))).toBe(true);
  });

  it("falls back to the generic label for a single result whose storage index is not active", async () => {
    const single: QueryResult = { columns: ["id"], rows: [[1]], sourceStatement: "SELECT 1" };
    const message: QueryResult = { columns: ["Message"], rows: [["notice"]], server_message: true };
    const { container } = await mountNavigator([message, single], true, "list", 0);
    const button = container.querySelector<HTMLButtonElement>("button")!;
    expect(button.textContent?.trim()).toBe("Result sets");
    expect(button.querySelector("svg")).toBeNull();
  });
});
