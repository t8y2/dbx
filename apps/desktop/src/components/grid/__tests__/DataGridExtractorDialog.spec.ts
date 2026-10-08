// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeDataGridExtractorOptions, type DataGridExtractPreview } from "@/lib/dataGrid/dataGridCopyExtractor";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
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

function mountDialog(preview = vi.fn(async () => result("initial")), open = false) {
  const props = reactive({ open, preference: "sql-inserts" as const, options: normalizeDataGridExtractorOptions({}), items: [{ value: "sql-inserts" as const, label: "INSERT" }], preview });
  const save = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(DataGridExtractorDialog, { ...props, onSave: save }) });
  app.mount(host);
  mounted.push({ app, host });
  return { props, host, save, preview };
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
  it("previews an initially open dialog", async () => {
    const { preview, host } = mountDialog(undefined, true);
    await advancePreview();
    expect(preview).toHaveBeenCalledOnce();
    expect(host.querySelector("pre")?.textContent).toBe("initial");
  });

  it("previews unsaved quote and temporal options without mutating saved settings", async () => {
    const { props, host, preview, save } = mountDialog();
    props.open = true;
    await advancePreview();
    await toggle(host, "copyExtractorQuoteIdentifiers");
    const select = Array.from(host.querySelectorAll("select")).find((item) => item.querySelector('option[value="string"]'))!;
    expect(select).toBeTruthy();
    select.value = "string";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await advancePreview();
    expect(preview).toHaveBeenLastCalledWith("sql-inserts", expect.objectContaining({ sql: expect.objectContaining({ quoteIdentifiers: false, temporalFormat: "string" }) }));
    expect(props.options.sql).toMatchObject({ quoteIdentifiers: true, temporalFormat: "native" });
    expect(save).not.toHaveBeenCalled();
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("common.save"))!;
    button.click();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ sql: expect.objectContaining({ quoteIdentifiers: false, temporalFormat: "string" }) }) }));
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
    await advancePreview();
    await toggle(host, "copyExtractorSkipComputed");
    if (settle === "resolve") old.resolve(result("stale"));
    else old.reject(new Error("stale error"));
    await nextTick();
    await nextTick();
    expect(host.querySelector("pre")?.textContent).not.toContain("stale");
    await advancePreview();
    await toggle(host, "copyExtractorSkipGenerated");
    await advancePreview();
    expect(host.querySelector("pre")?.textContent).toBe("latest");
    newer.resolve(result("also stale"));
    await nextTick();
    expect(host.querySelector("pre")?.textContent).toBe("latest");
  });

  it("shows current errors and resets draft options when reopened", async () => {
    const preview = vi.fn(async () => result("reopened")).mockRejectedValueOnce(new Error("preview failed"));
    const { props, host } = mountDialog(preview);
    props.open = true;
    await advancePreview();
    expect(host.querySelector("pre")?.textContent).toBe("preview failed");
    await toggle(host, "copyExtractorSkipComputed");
    props.open = false;
    await advancePreview();
    expect(preview).toHaveBeenCalledOnce();
    props.open = true;
    await advancePreview();
    expect(preview).toHaveBeenLastCalledWith("sql-inserts", props.options);
    expect(host.querySelector("pre")?.textContent).toBe("reopened");
  });

  it("ignores pending results after the dialog closes", async () => {
    const pending = deferred();
    const { props, host } = mountDialog(vi.fn(() => pending.promise));
    props.open = true;
    await advancePreview();
    props.open = false;
    await nextTick();
    pending.resolve(result("closed result"));
    await nextTick();
    expect(host.querySelector("pre")?.textContent).not.toContain("closed result");
  });
});
