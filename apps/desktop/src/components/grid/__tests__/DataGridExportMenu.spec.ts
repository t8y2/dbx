// @vitest-environment happy-dom
import { createApp, h, nextTick, ref } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataGridExportMenu from "../DataGridExportMenu.vue";

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  document.body.replaceChildren();
});

it("aligns selected rows before page and full-result formats and dispatches each original action once", async () => {
  const onSelect = vi.fn();
  const items = [
    ...["csv", "xlsx", "xlsx-with-sql", "json", "markdown", "html", "sql", "txt"].flatMap((format) => [
      { value: `selected-${format}`, label: `Selected ${format}` },
      { value: `page-${format}`, label: `Page ${format}` },
      { value: format, label: `All ${format}` },
    ]),
    { value: "database", label: "Database" },
    { value: "selected-cells-json", label: "Selected cells JSON", separatorBefore: true },
  ];
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(DataGridExportMenu, { items, label: "Export", onSelect }) });
  app.use(i18n);
  app.mount(host);
  unmount = () => app.unmount();
  for (const item of items) {
    host.querySelector<HTMLButtonElement>("button")!.click();
    await nextTick();
    await nextTick();
    const target = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === item.label || button.textContent?.trim() === item.label);
    expect(target, item.value).toBeDefined();
    if (item === items[0]) {
      const selected = document.querySelector('button[aria-label="Selected csv"]')!;
      const page = document.querySelector('button[aria-label="Page csv"]')!;
      const all = document.querySelector('button[aria-label="All csv"]')!;
      expect(selected.compareDocumentPosition(page) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(page.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(selected.textContent?.trim()).toBe("");
      expect(page.textContent?.trim()).toBe("");
      expect(all.textContent?.trim()).toBe("");
      expect(document.querySelectorAll('button[aria-label="Selected csv"]')).toHaveLength(1);
    }
    target!.click();
    await nextTick();
    expect(onSelect).toHaveBeenLastCalledWith(item.value);
    expect(host.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
  }
  expect(onSelect).toHaveBeenCalledTimes(items.length);
  host.querySelector<HTMLButtonElement>("button")!.click();
  await nextTick();
  await nextTick();
  document.querySelector<HTMLButtonElement>('button[aria-label="Page csv"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await nextTick();
  expect(host.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
  expect(onSelect).toHaveBeenCalledTimes(items.length);
});

it("shows the selected-row column only while selected-row actions exist", async () => {
  const items = ref([
    { value: "page-csv", label: "Page CSV" },
    { value: "csv", label: "All CSV" },
  ]);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(DataGridExportMenu, { items: items.value, label: "Export", onSelect: vi.fn() }) });
  app.use(i18n);
  app.mount(host);
  unmount = () => app.unmount();
  host.querySelector<HTMLButtonElement>("button")!.click();
  await nextTick();
  expect(document.body.textContent).not.toContain(i18n.global.t("grid.exportSelectedRowsScope"));
  items.value.push({ value: "selected-csv", label: "Selected CSV" });
  await nextTick();
  expect(document.body.textContent).toContain(i18n.global.t("grid.exportSelectedRowsScope"));
  expect(document.querySelectorAll('button[aria-label="Selected CSV"]')).toHaveLength(1);
  items.value.pop();
  await nextTick();
  expect(document.body.textContent).not.toContain(i18n.global.t("grid.exportSelectedRowsScope"));
});

/**
 * #14470 review: at a 320px viewport the scope columns used to squeeze the format
 * column down to roughly 20px, so labels such as "SQL INSERT" overflowed into the
 * download buttons. The column keeps a readable floor and the popover scrolls
 * sideways when the floor no longer fits.
 *
 * The measured layout lives in a real browser (verified at 320px: format column 84px,
 * popover 304px with 356px of scrollable content); this asserts the contract that
 * produces it, which happy-dom can check without layout.
 */
it("keeps a readable format column and lets the popover scroll instead of squeezing it", async () => {
  const mountWith = async (items: Array<{ value: string; label: string }>) => {
    unmount?.();
    document.body.replaceChildren();
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({ render: () => h(DataGridExportMenu, { items, label: "Export", onSelect: vi.fn() }) });
    app.use(i18n);
    app.mount(host);
    unmount = () => app.unmount();
    host.querySelector<HTMLButtonElement>("button")!.click();
    await nextTick();
    await nextTick();
    return document.querySelector<HTMLElement>("[data-export-menu-grid]")!;
  };

  // All three scope columns present.
  const fullGrid = await mountWith([
    { value: "page-csv", label: "Page CSV" },
    { value: "selected-csv", label: "Selected CSV" },
    { value: "csv", label: "All CSV" },
  ]);
  expect(fullGrid.style.gridTemplateColumns).toBe("minmax(84px,1fr) 80px 80px 88px");
  expect(fullGrid.style.minWidth).toBe("348px");

  // Without the selection column the same floor still fits inside the popover.
  const narrowGrid = await mountWith([
    { value: "page-csv", label: "Page CSV" },
    { value: "csv", label: "All CSV" },
  ]);
  expect(narrowGrid.style.gridTemplateColumns).toBe("minmax(84px,1fr) 80px 88px");
  expect(narrowGrid.style.minWidth).toBe("268px");

  // The popover itself must be able to scroll: without it the fixed floor would
  // simply clip the trailing column at a narrow viewport.
  expect(narrowGrid.closest(".overflow-x-auto")).not.toBeNull();
});

/**
 * #14470 review: the grid must recognize every scope the DataGrid emits, not just
 * `selected-*` / `page-*`. Selected cells and selected columns were falling through to
 * the stray list below the matrix, so the translations added for those headers were
 * never used and #14469 stayed unfixed for those two scopes.
 */
it("keeps selected cells and selected columns as their own scope columns", async () => {
  const onSelect = vi.fn();
  const items = [
    { value: "selected-columns-csv", label: "Selected columns CSV" },
    { value: "selected-cells-csv", label: "Selected cells CSV" },
    { value: "page-csv", label: "Page CSV" },
    { value: "csv", label: "All CSV" },
  ];
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(DataGridExportMenu, { items, label: "Export", onSelect }) });
  app.use(i18n);
  app.mount(host);
  unmount = () => app.unmount();

  host.querySelector<HTMLButtonElement>("button")!.click();
  await nextTick();
  await nextTick();

  const grid = document.querySelector<HTMLElement>("[data-export-menu-grid]")!;
  const headings = grid.textContent ?? "";
  expect(headings).toContain(i18n.global.t("grid.exportSelectedColumnsScope"));
  expect(headings).toContain(i18n.global.t("grid.exportSelectedCellsScope"));
  expect(headings).toContain(i18n.global.t("grid.exportPageScope"));
  expect(grid.style.gridTemplateColumns).toBe("minmax(84px,1fr) 80px 80px 80px 88px");
  expect(grid.style.minWidth).toBe("428px");

  for (const value of ["selected-columns-csv", "selected-cells-csv", "page-csv", "csv"]) {
    if (host.querySelector("button")!.getAttribute("aria-expanded") !== "true") {
      host.querySelector<HTMLButtonElement>("button")!.click();
      await nextTick();
      await nextTick();
    }
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${items.find((item) => item.value === value)!.label}"]`);
    expect(button, value).not.toBeNull();
    expect(document.querySelectorAll(`button[aria-label="${items.find((item) => item.value === value)!.label}"]`)).toHaveLength(1);
    button!.click();
    await nextTick();
    expect(onSelect).toHaveBeenLastCalledWith(value);
  }
});
