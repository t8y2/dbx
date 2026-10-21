// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_GRID_COPY_EXTRACTOR_IDS, DATA_GRID_DEFAULT_VISIBLE_COPY_EXTRACTORS, normalizeDataGridExtractorOptions, type DataGridCopyPreference, type DataGridExtractPreview } from "@/lib/dataGrid/dataGridCopyExtractor";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => (key === "grid.copyExtractorAdvancedOptions" ? "Advanced options" : key === "grid.copyExtractorVisibleFormats" ? "Visible formats" : key) }) }));
vi.mock("@/components/ui/dialog", () => {
  const passthrough = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return { Dialog: passthrough, DialogContent: passthrough, DialogFooter: passthrough, DialogHeader: passthrough, DialogTitle: passthrough };
});
vi.mock("@/components/ui/select", () => {
  const passthrough = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return {
    Select: defineComponent({
      props: ["modelValue"],
      emits: ["update:modelValue"],
      setup:
        (props, { emit, slots }) =>
        () =>
          h("select", { value: props.modelValue, onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value) }, slots.default?.()),
    }),
    SelectItem: defineComponent({
      props: ["value"],
      setup:
        (props, { slots }) =>
        () =>
          h("option", { value: props.value }, slots.default?.()),
    }),
    SelectContent: passthrough,
    SelectTrigger: passthrough,
    SelectValue: passthrough,
  };
});

import DataGridExtractorDialog from "../DataGridExtractorDialog.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];
const result = (text: string): DataGridExtractPreview => ({ text, mimeType: "text/plain", fileExtension: "sql", rowCount: 1, columnCount: 1, sourceRowCount: 1, truncated: false });

function deferred() {
  let resolve!: (value: DataGridExtractPreview) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<DataGridExtractPreview>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mountDialog(preview = vi.fn(async () => result("initial")), open = false, preference: DataGridCopyPreference = "sql-inserts") {
  const props = reactive({
    open,
    preference,
    sourceTableName: undefined as string | undefined,
    visibleCopyExtractors: [...DATA_GRID_DEFAULT_VISIBLE_COPY_EXTRACTORS],
    options: normalizeDataGridExtractorOptions({}),
    items: [{ value: "smart", label: "SMART" }, ...DATA_GRID_COPY_EXTRACTOR_IDS.map((value) => ({ value, label: value.toUpperCase() }))],
    mode: "configure" as "configure" | "copy",
    canCopy: vi.fn(() => true),
    copy: vi.fn(async () => true),
    preview,
  });
  const save = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(DataGridExtractorDialog, { ...props, visibleItems: DATA_GRID_COPY_EXTRACTOR_IDS.map((value) => ({ value, label: value })), onSave: save }) });
  app.mount(host);
  mounted.push({ app, host });
  return { props, host, save, preview, copy: props.copy };
}

async function advancePreview() {
  await nextTick();
  await vi.advanceTimersByTimeAsync(180);
  await nextTick();
}

async function toggle(host: HTMLElement, key: string) {
  const label = Array.from(host.querySelectorAll("label")).find((item) => item.textContent?.includes(key));
  const input = label?.querySelector("input");
  expect(input).toBeTruthy();
  input!.checked = !input!.checked;
  input!.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
}

async function expandPreview(host: HTMLElement) {
  await nextTick();
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes("grid.copyExtractorPreview"));
  expect(button).toBeTruthy();
  if (button!.getAttribute("aria-expanded") !== "true") {
    button!.click();
    await nextTick();
  }
  await advancePreview();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.useRealTimers();
});

describe("extractor draft preview", () => {
  it("shows CSV-specific settings only for CSV and DSV extractors", async () => {
    const { host } = mountDialog(undefined, true, "tsv");
    expect(host.textContent).not.toContain("grid.copyExtractorEscapeFormulas");
    expect(host.textContent).not.toContain("grid.copyExtractorHeaderPosition");
    const csv = mountDialog(undefined, true, "csv");
    expect(csv.host.textContent).toContain("grid.copyExtractorEscapeFormulas");
    expect(csv.host.textContent).toContain("grid.copyExtractorHeaderPosition");
    expect(csv.host.querySelectorAll("details")).toHaveLength(2);
    expect([...csv.host.querySelectorAll("details")].every((details) => !details.open)).toBe(true);
    expect([...csv.host.querySelectorAll("details summary")].map((summary) => summary.textContent)).toContain("Advanced options");
  });

  it("keeps smart, raw, DbUnit and hidden formats in the property workflow and honors capability disabling", async () => {
    const { props, host } = mountDialog(undefined, true, "smart");
    expect(host.textContent).toContain("grid.copyExtractorSmart");
    expect(host.textContent).not.toContain("grid.copyExtractorValueFormat");
    host.querySelector<HTMLInputElement>('input[type="radio"][value="raw"]')!.click();
    await nextTick();
    expect(host.textContent).toContain("grid.copyExtractorRawHint");
    expect(host.textContent).not.toContain("grid.copyExtractorValueFormat");
    host.querySelector<HTMLInputElement>('input[type="radio"][value="dbunit"]')!.click();
    await nextTick();
    expect(host.textContent).toContain("grid.copyDbunitTableName");

    props.visibleCopyExtractors = props.visibleCopyExtractors.filter((item) => item !== "php");
    props.items.find((item) => item.value === "sql-updates")!.disabled = true;
    await nextTick();
    expect(host.querySelector<HTMLInputElement>('input[type="radio"][value="php"]')).toBeTruthy();
    expect(host.querySelector<HTMLInputElement>('input[type="radio"][value="php"]')?.disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>('input[type="radio"][value="sql-updates"]')?.disabled).toBe(true);
  });

  it.each(["tsv", "tsv-with-headers", "pipe-separated"] as const)("keeps the row-number option available for %s", async (preference) => {
    const { props, host, save } = mountDialog(undefined, true, preference);

    const label = Array.from(host.querySelectorAll("label")).find((item) => item.textContent?.includes("grid.copyExtractorIncludeRowHeader"));
    expect(label).toBeTruthy();
    expect(label?.closest("details")).toBeNull();
    await toggle(host, "grid.copyExtractorIncludeRowHeader");

    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("common.save"))!;
    button.click();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ dsv: expect.objectContaining({ includeRowHeader: true }) }) }));
    expect(props.options.dsv.includeRowHeader).toBe(false);
  });

  it("does not preview or hydrate until the collapsed preview is expanded", async () => {
    const { preview, host } = mountDialog(undefined, true);
    await advancePreview();
    expect(host.querySelector("pre")).toBeNull();
    expect(preview).not.toHaveBeenCalled();
    await expandPreview(host);
    expect(preview).toHaveBeenCalledOnce();
    expect(host.querySelector("pre")?.textContent).toBe("initial");
  });

  it("offers the database-name option for SQL updates as well (#11195, #12146)", async () => {
    const { props, host, save } = mountDialog();
    props.preference = "sql-updates";
    props.items = [{ value: "sql-updates", label: "UPDATE" }];
    props.open = true;
    await expandPreview(host);

    // 默认开启，取消勾选后保存应带上 includeDatabaseName: false
    await toggle(host, "copyExtractorIncludeDatabaseName");
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("common.save"))!;
    button.click();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ sql: expect.objectContaining({ includeDatabaseName: false }) }) }));
  });

  it("previews unsaved quote and temporal options without mutating saved settings", async () => {
    const { props, host, preview, save } = mountDialog();
    props.open = true;
    await expandPreview(host);
    await toggle(host, "copyExtractorQuoteIdentifiers");
    const select = Array.from(host.querySelectorAll("select")).find((item) => item.querySelector('option[value="string"]'))!;
    expect(select).toBeTruthy();
    select.value = "string";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await expandPreview(host);
    expect(preview).toHaveBeenLastCalledWith("sql-inserts", expect.objectContaining({ sql: expect.objectContaining({ quoteIdentifiers: false, temporalFormat: "string" }) }));
    expect(props.options.sql).toMatchObject({ quoteIdentifiers: true, temporalFormat: "native" });
    expect(save).not.toHaveBeenCalled();
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("common.save"))!;
    button.click();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ sql: expect.objectContaining({ quoteIdentifiers: false, temporalFormat: "string" }) }) }));
  });

  it("keeps the configured default separate from the format being edited and discards copy-mode drafts", async () => {
    const { props, host, save, copy } = mountDialog(undefined, true, "sql-inserts");
    const csv = host.querySelector<HTMLInputElement>('input[type="radio"][value="csv"]')!;
    csv.click();
    await nextTick();
    expect(host.textContent).toContain("grid.copyExtractorEscapeFormulas");
    const defaultSelect = host.querySelector<HTMLSelectElement>("select");
    expect(defaultSelect?.value).toBe("sql-inserts");
    defaultSelect!.value = "tsv";
    defaultSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("common.cancel"))?.click();
    expect(save).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();

    props.open = false;
    await nextTick();
    props.mode = "copy";
    props.open = true;
    await nextTick();
    const php = host.querySelector<HTMLInputElement>('input[type="radio"][value="php"]')!;
    php.click();
    await nextTick();
    expect(host.querySelector('button[type="button"]')).toBeTruthy();
    const copyButton = [...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === "grid.copy").at(-1);
    copyButton!.click();
    await nextTick();
    expect(copy).toHaveBeenCalledWith("php", expect.any(Object));
    expect(save).not.toHaveBeenCalled();
  });

  it("saves only the explicit default selection, not the format currently being browsed", async () => {
    const { host, save } = mountDialog(undefined, true, "sql-inserts");
    host.querySelector<HTMLInputElement>('input[type="radio"][value="csv"]')!.click();
    await nextTick();
    const defaultSelect = host.querySelector<HTMLSelectElement>("select")!;
    defaultSelect.value = "tsv";
    defaultSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("common.save"))!.click();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ preference: "tsv" }));
  });

  it("uses arrow keys to move the format radio selection and focus", async () => {
    const { host } = mountDialog(undefined, true, "tsv");
    const selected = host.querySelector<HTMLInputElement>('input[type="radio"][value="tsv"]')!;
    selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await nextTick();
    expect(host.querySelector<HTMLInputElement>('input[type="radio"][value="tsv-with-headers"]')?.checked).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('input[type="radio"][value="tsv-with-headers"]'));
    const currentRadio = host.querySelector<HTMLInputElement>('input[type="radio"][value="tsv-with-headers"]')!;
    currentRadio.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await nextTick();
    expect(host.querySelector<HTMLInputElement>('input[type="radio"][value="php"]')?.checked).toBe(true);
    host.querySelector<HTMLInputElement>('input[type="radio"][value="php"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await nextTick();
    expect(host.querySelector<HTMLInputElement>('input[type="radio"][value="smart"]')?.checked).toBe(true);
  });

  it("disables one-time copy for missing capability or invalid PHP options and never submits on Enter", async () => {
    const { props, host, copy } = mountDialog(undefined, true, "smart");
    props.mode = "copy";
    await nextTick();
    props.canCopy = vi.fn(() => false);
    await nextTick();
    const copyButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "grid.copy")!;
    expect(copyButton.disabled).toBe(true);
    props.canCopy = vi.fn(() => true);
    host.querySelector<HTMLInputElement>('input[type="radio"][value="php"]')!.click();
    await nextTick();
    const phpVariableLabel = [...host.querySelectorAll("label")].find((label) => label.textContent?.includes("grid.copyPhpVariable"));
    const phpVariable = phpVariableLabel?.parentElement?.querySelector<HTMLInputElement>("input");
    expect(phpVariable).toBeTruthy();
    phpVariable!.value = "invalid name";
    phpVariable!.dispatchEvent(new Event("input", { bubbles: true }));
    phpVariable!.dispatchEvent(new Event("change", { bubbles: true }));
    phpVariable!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await nextTick();
    expect(copyButton.disabled).toBe(true);
    expect(copy).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("ignores an old %s during the debounce window and after a newer preview", async (settle) => {
    const old = deferred();
    const newer = deferred();
    const preview = vi
      .fn(async () => result("latest"))
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(newer.promise);
    const { props, host } = mountDialog(preview);
    props.open = true;
    await expandPreview(host);
    await toggle(host, "copyExtractorSkipComputed");
    if (settle === "resolve") old.resolve(result("stale"));
    else old.reject(new Error("stale error"));
    await nextTick();
    await nextTick();
    expect(host.querySelector("pre")?.textContent ?? "").not.toContain("stale");
    await advancePreview();
    await toggle(host, "copyExtractorSkipGenerated");
    await advancePreview();
    expect(host.querySelector("pre")?.textContent).toBe("latest");
    newer.resolve(result("also stale"));
    await nextTick();
    expect(host.querySelector("pre")?.textContent).toBe("latest");
  });

  it("ignores a late preview after switching formats and collapsing the preview", async () => {
    const old = deferred();
    const preview = vi.fn(async () => result("latest")).mockReturnValueOnce(old.promise);
    const { props, host } = mountDialog(preview);
    props.open = true;
    await expandPreview(host);
    host.querySelector<HTMLInputElement>('input[type="radio"][value="csv"]')!.click();
    await advancePreview();
    const previewButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("grid.copyExtractorPreview"))!;
    previewButton.click();
    await nextTick();
    old.resolve(result("collapsed stale"));
    await nextTick();
    expect(host.querySelector("pre")).toBeNull();
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed one-time copy draft open for retry", async () => {
    const { props, host, copy, save } = mountDialog();
    props.mode = "copy";
    props.copy = vi.fn().mockRejectedValueOnce(new Error("clipboard unavailable")).mockResolvedValueOnce(true);
    props.open = true;
    await nextTick();
    const copyButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "grid.copy")!;
    copyButton.click();
    await Promise.resolve();
    await nextTick();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("clipboard unavailable");
    expect(props.open).toBe(true);
    copyButton.click();
    await Promise.resolve();
    await nextTick();
    expect(props.copy).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it("does not let a completed copy from a closed dialog session affect a reopened dialog", async () => {
    let resolveCopy!: (copied: boolean) => void;
    const { props, host } = mountDialog();
    props.mode = "copy";
    props.copy = vi.fn(() => new Promise<boolean>((resolve) => (resolveCopy = resolve)));
    props.open = true;
    await nextTick();
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "grid.copy")!.click();
    await nextTick();

    props.open = false;
    await nextTick();
    props.open = true;
    await nextTick();
    resolveCopy(true);
    await nextTick();

    expect(props.open).toBe(true);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.trim() === "grid.copy")).toBe(true);
  });

  it("shows current errors and resets draft options when reopened", async () => {
    const preview = vi.fn(async () => result("reopened")).mockRejectedValueOnce(new Error("preview failed"));
    const { props, host } = mountDialog(preview);
    props.open = true;
    await expandPreview(host);
    expect(host.querySelector("pre")?.textContent).toBe("preview failed");
    expect(host.querySelector("pre")?.classList.contains("break-words")).toBe(true);
    expect(host.querySelector("pre")?.classList.contains("whitespace-pre-wrap")).toBe(true);
    await toggle(host, "copyExtractorSkipComputed");
    props.open = false;
    await advancePreview();
    expect(preview).toHaveBeenCalledOnce();
    props.open = true;
    await expandPreview(host);
    expect(preview).toHaveBeenLastCalledWith("sql-inserts", props.options);
    expect(host.querySelector("pre")?.textContent).toBe("reopened");
  });

  it("ignores pending results after the dialog closes", async () => {
    const pending = deferred();
    const { props, host } = mountDialog(vi.fn(() => pending.promise));
    props.open = true;
    await expandPreview(host);
    props.open = false;
    await nextTick();
    pending.resolve(result("closed result"));
    await nextTick();
    expect(host.querySelector("pre")?.textContent ?? "").not.toContain("closed result");
  });
});
