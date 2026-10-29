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
