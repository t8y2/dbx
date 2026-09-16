// @vitest-environment happy-dom

import { defineComponent, h, nextTick, ref } from "vue";
import { createApp } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MongoImportPreview } from "@/lib/backend/api";

const api = vi.hoisted(() => ({
  previewMongodbImportFile: vi.fn(),
  importMongodbFile: vi.fn(),
  cancelMongodbImport: vi.fn(),
  releaseMongodbImportSource: vi.fn(),
}));

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => api);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ getConfig: () => ({ id: "c1", name: "mongo", read_only: false }), mongoImportCompleted: null }),
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({
  executeWithProductionContextGuard: async ({ execute }: { execute: () => Promise<unknown> }) => execute(),
}));

vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");

  function collectOptions(nodes: unknown[] | undefined): ReturnType<typeof h>[] {
    if (!nodes) return [];
    const options: ReturnType<typeof h>[] = [];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const vnode = node as { type?: { name?: string }; props?: { value?: unknown }; children?: unknown };
      if (vnode.type?.name === "SelectItemStub") {
        const children = vnode.children;
        const label = typeof children === "object" && children && "default" in children && typeof (children as { default: unknown }).default === "function" ? (children as { default: () => unknown }).default() : children;
        options.push(h("option", { value: String(vnode.props?.value ?? "") }, label as never));
        continue;
      }
      const children = vnode.children;
      if (typeof children === "object" && children && "default" in children && typeof (children as { default: unknown }).default === "function") {
        options.push(...collectOptions((children as { default: () => unknown[] }).default()));
      } else if (Array.isArray(children)) {
        options.push(...collectOptions(children));
      }
    }
    return options;
  }

  return {
    Select: defineComponent({
      props: { modelValue: { type: [String, Number, Boolean], default: undefined } },
      emits: ["update:modelValue"],
      setup(props, { emit, slots, attrs }) {
        return () =>
          h(
            "select",
            {
              ...attrs,
              value: props.modelValue,
              onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value),
            },
            collectOptions(slots.default?.() as unknown[] | undefined),
          );
      },
    }),
    SelectItem: defineComponent({
      name: "SelectItemStub",
      props: { value: { type: [String, Number, Boolean], required: true } },
      setup: () => () => null,
    }),
    SelectContent: defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h("div", slots.default?.()),
    }),
    SelectTrigger: defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h("div", slots.default?.()),
    }),
    SelectValue: defineComponent({
      setup: () => () => null,
    }),
  };
});

import MongoImportDialog from "../MongoImportDialog.vue";

function previewResult(overrides: Partial<MongoImportPreview> = {}): MongoImportPreview {
  return {
    sourceRef: "src-1",
    format: "csv",
    fileName: "orders.csv",
    filePath: "/tmp/orders.csv",
    sizeBytes: 12,
    columns: [{ name: "id", inferredType: "string" }],
    rows: [{ id: "1" }],
    warnings: [],
    errors: [],
    estimatedRows: 1,
    estimatedRowsExact: true,
    ...overrides,
  };
}

describe("MongoImportDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.previewMongodbImportFile.mockReset().mockResolvedValue(previewResult());
    api.releaseMongodbImportSource.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("keeps the collection target in the wizard", async () => {
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(MongoImportDialog, {
              open: true,
              connectionId: "c1",
              database: "shop",
              collection: "orders",
            });
        },
      }),
    );
    app.mount(document.body);
    await nextTick();
    expect(document.body.textContent).toContain("shop.orders");
    app.unmount();
  });

  it("does not override the selected format from the file extension", async () => {
    const app = createApp(
      defineComponent({
        setup() {
          return () => h(MongoImportDialog, { open: true, connectionId: "c1", database: "shop", collection: "orders" });
        },
      }),
    );
    app.mount(document.body);
    await nextTick();

    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const file = new File([new Uint8Array([5, 0, 0, 0, 0])], "orders.bson.gz", { type: "application/gzip" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await nextTick();

    expect(api.previewMongodbImportFile.mock.calls[0]?.[1]).toMatchObject({
      format: "csv",
      parseOptions: { delimiter: ",", typeMode: "auto" },
    });
    expect(document.body.textContent).toContain("tableImport.encoding");
    expect(document.body.textContent).toContain("mongo.import.typeMode");
    app.unmount();
  });

  it("keeps an explicitly selected BSON format when changing files", async () => {
    api.previewMongodbImportFile.mockResolvedValue(previewResult({ format: "bson" }));
    const app = createApp(MongoImportDialog, { open: true, connectionId: "c1", database: "shop", collection: "orders" });
    app.mount(document.body);
    await nextTick();
    await setLabeledSelect("tableImport.sourceFormat", "bson");
    expect(document.body.textContent).not.toContain("tableImport.encoding");

    for (const name of ["orders.bson", "renamed.json"]) {
      const input = document.querySelector("input[type='file']") as HTMLInputElement;
      Object.defineProperty(input, "files", { configurable: true, value: [new File([new Uint8Array([5, 0, 0, 0, 0])], name)] });
      input.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(200);
      await nextTick();
      expect(api.previewMongodbImportFile.mock.lastCall?.[1]).toMatchObject({ format: "bson" });
    }
    app.unmount();
  });

  it("reuses the uploaded sourceRef on later previews and releases it on close", async () => {
    const open = ref(true);
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(MongoImportDialog, {
              open: open.value,
              "onUpdate:open": (value: boolean) => {
                open.value = value;
              },
              connectionId: "c1",
              database: "shop",
              collection: "orders",
            });
        },
      }),
    );
    app.mount(document.body);
    await nextTick();

    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const file = new File(["id\n1"], "orders.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await nextTick();

    expect(api.previewMongodbImportFile).toHaveBeenCalledTimes(1);
    const firstSource = api.previewMongodbImportFile.mock.calls[0]?.[0];
    expect(firstSource).toBeInstanceOf(File);
    expect((firstSource as File).name).toBe("orders.csv");
    expect(api.previewMongodbImportFile.mock.calls[0]?.[1]).toMatchObject({ sourceRef: null });

    const header = document.querySelector("input[type='checkbox']") as HTMLInputElement;
    header.click();
    await nextTick();
    const next = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("tableImport.next"));
    expect(next?.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await nextTick();

    expect(api.previewMongodbImportFile).toHaveBeenCalledTimes(2);
    expect(api.previewMongodbImportFile.mock.calls[1]?.[0]).toBe("/tmp/orders.csv");
    expect(api.previewMongodbImportFile.mock.calls[1]?.[1]).toMatchObject({ sourceRef: "src-1" });

    open.value = false;
    await nextTick();
    expect(api.releaseMongodbImportSource).toHaveBeenCalledWith("src-1");
    app.unmount();
  });

  async function mountWithFile(fileName: string, preview: MongoImportPreview, format: MongoImportPreview["format"] = "csv") {
    api.previewMongodbImportFile.mockResolvedValue(preview);
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(MongoImportDialog, {
              open: true,
              connectionId: "c1",
              database: "shop",
              collection: "orders",
            });
        },
      }),
    );
    app.mount(document.body);
    await nextTick();
    if (format !== "csv") await setLabeledSelect("tableImport.sourceFormat", format);
    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const file = new File(["id\n1"], fileName, { type: "text/csv" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await nextTick();
    return app;
  }

  function columnTypeTrigger() {
    return document.querySelector('button[aria-label="mongo.import.columnType"]') as HTMLButtonElement | null;
  }

  async function setColumnTypeValue(value: string) {
    const trigger = columnTypeTrigger();
    expect(trigger).not.toBeNull();
    trigger!.click();
    await nextTick();
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((element) => (element.textContent ?? "").includes(`inferredType.${value}`)) as HTMLButtonElement | undefined;
    expect(item).toBeTruthy();
    item!.click();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await nextTick();
  }

  it("defaults csv column types to inference and lets the user override them", async () => {
    const app = await mountWithFile("orders.csv", previewResult({ columns: [{ name: "id", inferredType: "integer" }], rows: [{ id: 1 }] }));
    const trigger = columnTypeTrigger();
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("inferredType.integer");
    expect(trigger?.getAttribute("aria-label")).toBe("mongo.import.columnType");

    await setColumnTypeValue("string");

    expect(api.previewMongodbImportFile.mock.calls.at(-1)?.[1]).toMatchObject({
      parseOptions: expect.objectContaining({ columnTypes: { id: "string" } }),
    });
    app.unmount();
  });

  it("selects a column type on pointerdown so dialogs do not swallow the click", async () => {
    const app = await mountWithFile("orders.csv", previewResult({ columns: [{ name: "id", inferredType: "integer" }], rows: [{ id: 1 }] }));
    const trigger = columnTypeTrigger();
    expect(trigger).not.toBeNull();
    trigger!.click();
    await nextTick();
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((element) => (element.textContent ?? "").includes("inferredType.boolean")) as HTMLButtonElement | undefined;
    expect(item).toBeTruthy();
    item!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await nextTick();
    expect(api.previewMongodbImportFile.mock.calls.at(-1)?.[1]).toMatchObject({
      parseOptions: expect.objectContaining({ columnTypes: { id: "boolean" } }),
    });
    app.unmount();
  });

  it("does not replace the preview table with a loading state when column types change", async () => {
    const app = await mountWithFile("orders.csv", previewResult({ columns: [{ name: "id", inferredType: "integer" }], rows: [{ id: 1 }] }));
    expect(columnTypeTrigger()).not.toBeNull();
    api.previewMongodbImportFile.mockImplementation(() => new Promise(() => {}));

    const trigger = columnTypeTrigger();
    trigger!.click();
    await nextTick();
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((element) => (element.textContent ?? "").includes("inferredType.string")) as HTMLButtonElement | undefined;
    expect(item).toBeTruthy();
    item!.click();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await nextTick();

    expect(columnTypeTrigger()).not.toBeNull();
    expect(document.body.textContent).not.toContain("mongo.import.previewing");
    app.unmount();
  });

  it("clears column type overrides when the file changes", async () => {
    const app = await mountWithFile("orders.csv", previewResult({ columns: [{ name: "id", inferredType: "integer" }] }));
    await setColumnTypeValue("string");

    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const file = new File(["id\n2"], "other.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await nextTick();

    expect(api.previewMongodbImportFile.mock.calls.at(-1)?.[1]).toMatchObject({
      parseOptions: expect.objectContaining({ columnTypes: null }),
    });
    app.unmount();
  });

  it("does not show column type editors for json imports", async () => {
    const app = await mountWithFile(
      "orders.json",
      previewResult({
        format: "json",
        fileName: "orders.json",
        columns: [{ name: "id", inferredType: "string" }],
      }),
      "json",
    );
    expect(columnTypeTrigger()).toBeNull();
    expect(document.body.textContent).toContain("(string)");
    app.unmount();
  });

  function lastParseOptions() {
    return api.previewMongodbImportFile.mock.calls.at(-1)?.[1]?.parseOptions as Record<string, unknown> | undefined;
  }

  async function overrideIdToString() {
    await setColumnTypeValue("string");
  }

  async function setLabeledSelect(label: string, value: string) {
    const select = document.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
    expect(select).not.toBeNull();
    select.value = value;
    select.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await nextTick();
  }

  it("keeps column type overrides when only the delimiter changes", async () => {
    const app = await mountWithFile("orders.csv", previewResult({ columns: [{ name: "id", inferredType: "integer" }] }));
    await overrideIdToString();
    expect(lastParseOptions()).toMatchObject({ columnTypes: { id: "string" } });

    const delimiter = document.querySelector('input[aria-label="tableImport.delimiter"]') as HTMLInputElement;
    expect(delimiter).not.toBeNull();
    delimiter.value = ";";
    delimiter.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await nextTick();

    expect(lastParseOptions()).toMatchObject({ columnTypes: { id: "string" }, delimiter: ";" });
    app.unmount();
  });

  it("clears column type overrides when format, header row, or type mode changes", async () => {
    const app = await mountWithFile("orders.csv", previewResult({ columns: [{ name: "id", inferredType: "integer" }] }));

    await overrideIdToString();
    await setLabeledSelect("tableImport.sourceFormat", "json");
    expect(lastParseOptions()).toMatchObject({ columnTypes: null });

    await setLabeledSelect("tableImport.sourceFormat", "csv");
    await overrideIdToString();
    const header = document.querySelector('input[aria-label="tableImport.hasHeader"]') as HTMLInputElement;
    header.click();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await nextTick();
    expect(lastParseOptions()).toMatchObject({ columnTypes: null });

    await overrideIdToString();
    await setLabeledSelect("mongo.import.typeMode", "string");
    expect(lastParseOptions()).toMatchObject({ columnTypes: null });

    app.unmount();
  });
});
