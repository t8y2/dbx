// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TableImportPreview } from "@/lib/backend/api";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listTables: vi.fn().mockResolvedValue([{ name: "target_table", table_type: "TABLE" }]),
  getColumns: vi.fn().mockResolvedValue([
    { name: "id", data_type: "INTEGER", nullable: false },
    { name: "name", data_type: "TEXT", nullable: true },
  ]),
  listDataTypes: vi.fn().mockResolvedValue(["INTEGER", "TEXT", "VARCHAR", "DATETIME"]),
  previewTableImportFile: vi.fn(),
  importTableFile: vi.fn(),
  releaseTableImportSource: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: (id: string) => (id === "connection-1" ? { id, name: "SQLite", db_type: "sqlite" } : undefined),
    ensureConnected: mocks.ensureConnected,
    invalidateMetadataCache: vi.fn(),
    refreshObjectListTreeNode: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings: {} }),
}));

vi.mock("@/lib/backend/api", () => ({
  listTables: mocks.listTables,
  getColumns: mocks.getColumns,
  listDataTypes: mocks.listDataTypes,
  previewTableImportFile: mocks.previewTableImportFile,
  releaseTableImportSource: mocks.releaseTableImportSource,
  importTableFile: mocks.importTableFile,
  cancelTableImport: vi.fn(),
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { attrs, slots }) {
      return () => h("div", attrs, slots.default?.());
    },
  });
  return {
    Dialog: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
    DialogFooter: passthrough,
    DialogScrollContent: passthrough,
  };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      props: { disabled: Boolean },
      emits: ["click"],
      setup(props, { attrs, slots, emit }) {
        return () => h("button", { ...attrs, disabled: props.disabled, onClick: () => emit("click") }, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      props: { modelValue: [String, Number], disabled: Boolean },
      emits: ["update:modelValue"],
      setup(props, { attrs, emit }) {
        return () =>
          h("input", {
            ...attrs,
            value: props.modelValue,
            disabled: props.disabled,
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
          });
      },
    }),
  };
});

vi.mock("@/components/ui/label", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Label: defineComponent({
      setup(_props, { slots }) {
        return () => h("label", slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h, inject, provide } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return {
    Select: defineComponent({
      props: { modelValue: String },
      emits: ["update:modelValue"],
      setup(_props, { emit, slots }) {
        provide("selectOption", (value: string) => emit("update:modelValue", value));
        return () => h("div", slots.default?.());
      },
    }),
    SelectContent: passthrough,
    SelectItem: defineComponent({
      props: { value: String },
      setup(props, { slots }) {
        const selectOption = inject<(value: string) => void>("selectOption");
        return () => h("span", { "data-select-option": props.value, onClick: () => selectOption?.(props.value || "") }, slots.default?.());
      },
    }),
    SelectTrigger: passthrough,
    SelectValue: passthrough,
  };
});

vi.mock("@/components/ui/searchable-select", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    SearchableSelect: defineComponent({
      props: {
        modelValue: { type: String, default: "" },
        options: { type: Array<string>, default: () => [] },
        disabled: Boolean,
      },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () =>
          h(
            "select",
            {
              class: "existing-table-select-stub",
              value: props.modelValue,
              disabled: props.disabled,
              onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value),
            },
            [h("option", { value: "" }), ...(props.options as string[]).map((option) => h("option", { value: option }, option))],
          );
      },
    }),
  };
});

import TableImportDialog from "@/components/import/TableImportDialog.vue";

const mountedApps: App[] = [];

const previewData: TableImportPreview = {
  fileName: "test_data.csv",
  filePath: "/tmp/test_data.csv",
  sourceRef: "delimited-test",
  fileType: "csv",
  sizeBytes: 100,
  columns: ["id", "name"],
  rows: [
    [1, "Alice"],
    [2, "Bob"],
  ],
  totalRows: 2,
  totalRowsExact: true,
  sourceFingerprint: "test-data-csv",
};

async function flushAsyncUpdates() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await nextTick();
}

async function selectFiles(files: File[]) {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(input).toBeTruthy();
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flushAsyncUpdates();
}

async function mountDialogAndGoToStep2(options: { prefillTable?: string } = {}) {
  mocks.previewTableImportFile.mockResolvedValue(previewData);
  const container = document.createElement("div");
  document.body.append(container);

  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(TableImportDialog, {
          open: true,
          prefillConnectionId: "connection-1",
          prefillDatabase: "main",
          ...(options.prefillTable ? { prefillTable: options.prefillTable } : {}),
        }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);

  await flushAsyncUpdates();
  await selectFiles([new File(["id,name\n1,Alice"], "test_data.csv")]);

  // 点击下一步到达 Step 2（列映射页面）
  const nextButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Next");
  expect(nextButton).toBeTruthy();
  nextButton!.click();
  await flushAsyncUpdates();

  return { container };
}

beforeEach(() => {
  i18n.global.locale.value = "en";
  mocks.listTables.mockReset().mockResolvedValue([{ name: "target_table", table_type: "TABLE" }]);
  mocks.previewTableImportFile.mockReset().mockResolvedValue(previewData);
  mocks.listDataTypes.mockReset().mockResolvedValue(["INTEGER", "TEXT", "VARCHAR"]);
  mocks.releaseTableImportSource.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("TableImportDialog popovers lifecycle and positioning", () => {
  describe("generatorPicker lifecycle & interaction", () => {
    it("点击生成器触发按钮能打开 generatorPicker 下拉框", async () => {
      await mountDialogAndGoToStep2();

      // 查找触发 generatorPicker 的按钮（带 data-generator-picker 属性）
      const genButtons = [...document.body.querySelectorAll<HTMLElement>("button[data-generator-picker]")];
      expect(genButtons.length).toBeGreaterThan(0);

      // 触发打开
      genButtons[0]!.click();
      await flushAsyncUpdates();

      const menu = document.getElementById("table-import-generator-options");
      expect(menu).toBeTruthy();
      expect(menu?.getAttribute("role")).toBe("listbox");
    });

    it("按下 Escape 键时能够安全关闭 generatorPicker", async () => {
      await mountDialogAndGoToStep2();

      const genButtons = [...document.body.querySelectorAll<HTMLElement>("button[data-generator-picker]")];
      genButtons[0]!.click();
      await flushAsyncUpdates();

      expect(document.getElementById("table-import-generator-options")).toBeTruthy();

      // 模拟按下 Escape
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flushAsyncUpdates();

      expect(document.getElementById("table-import-generator-options")).toBeNull();
    });

    it("点击外部区域时触发 onOutsidePointerDown 自动关闭 generatorPicker", async () => {
      await mountDialogAndGoToStep2();

      const genButtons = [...document.body.querySelectorAll<HTMLElement>("button[data-generator-picker]")];
      genButtons[0]!.click();
      await flushAsyncUpdates();

      expect(document.getElementById("table-import-generator-options")).toBeTruthy();

      // 在空白外部区域触发 pointerdown
      const outsideDiv = document.createElement("div");
      document.body.append(outsideDiv);
      outsideDiv.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await flushAsyncUpdates();

      expect(document.getElementById("table-import-generator-options")).toBeNull();
      outsideDiv.remove();
    });

    it("点击 generatorPicker 内部不会关闭自身", async () => {
      await mountDialogAndGoToStep2();

      const genButtons = [...document.body.querySelectorAll<HTMLElement>("button[data-generator-picker]")];
      genButtons[0]!.click();
      await flushAsyncUpdates();

      const menu = document.getElementById("table-import-generator-options");
      expect(menu).toBeTruthy();

      menu!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await flushAsyncUpdates();

      expect(document.getElementById("table-import-generator-options")).toBeTruthy();
    });
  });

  describe("dataTypePicker lifecycle & interaction", () => {
    it("聚焦数据类型输入框时打开 dataTypePicker", async () => {
      await mountDialogAndGoToStep2();

      const dtInputs = [...document.body.querySelectorAll<HTMLInputElement>("input[data-dt-input]")];
      expect(dtInputs.length).toBeGreaterThan(0);

      dtInputs[0]!.focus();
      await flushAsyncUpdates();

      const dtMenu = document.getElementById("table-import-data-type-options");
      expect(dtMenu).toBeTruthy();
    });

    it("按下 Escape 键能够关闭 dataTypePicker", async () => {
      await mountDialogAndGoToStep2();

      const dtInputs = [...document.body.querySelectorAll<HTMLInputElement>("input[data-dt-input]")];
      dtInputs[0]!.focus();
      await flushAsyncUpdates();

      expect(document.getElementById("table-import-data-type-options")).toBeTruthy();

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flushAsyncUpdates();

      expect(document.getElementById("table-import-data-type-options")).toBeNull();
    });

    it("点击外部区域时通过 pointerdown 安全收起 dataTypePicker", async () => {
      await mountDialogAndGoToStep2();

      const dtInputs = [...document.body.querySelectorAll<HTMLInputElement>("input[data-dt-input]")];
      dtInputs[0]!.focus();
      await flushAsyncUpdates();

      expect(document.getElementById("table-import-data-type-options")).toBeTruthy();

      const outsideDiv = document.createElement("div");
      document.body.append(outsideDiv);
      outsideDiv.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await flushAsyncUpdates();

      expect(document.getElementById("table-import-data-type-options")).toBeNull();
      outsideDiv.remove();
    });
  });

  describe("两个下拉框互斥与位置同步更新 (Position Follow & Exclusivity)", () => {
    it("打开 dataTypePicker 时会自动关闭已打开的 generatorPicker", async () => {
      await mountDialogAndGoToStep2();

      // 先打开 generatorPicker
      const genButtons = [...document.body.querySelectorAll<HTMLElement>("button[data-generator-picker]")];
      genButtons[0]!.click();
      await flushAsyncUpdates();
      expect(document.getElementById("table-import-generator-options")).toBeTruthy();

      // 再打开 dataTypePicker
      const dtInputs = [...document.body.querySelectorAll<HTMLInputElement>("input[data-dt-input]")];
      dtInputs[0]!.focus();
      await flushAsyncUpdates();

      // generatorPicker 关闭，dataTypePicker 打开
      expect(document.getElementById("table-import-generator-options")).toBeNull();
      expect(document.getElementById("table-import-data-type-options")).toBeTruthy();
    });

    it("打开 generatorPicker 时会自动关闭已打开的 dataTypePicker", async () => {
      await mountDialogAndGoToStep2();

      // 先打开 dataTypePicker
      const dtInputs = [...document.body.querySelectorAll<HTMLInputElement>("input[data-dt-input]")];
      dtInputs[0]!.focus();
      await flushAsyncUpdates();
      expect(document.getElementById("table-import-data-type-options")).toBeTruthy();

      // 再打开 generatorPicker
      const genButtons = [...document.body.querySelectorAll<HTMLElement>("button[data-generator-picker]")];
      genButtons[0]!.click();
      await flushAsyncUpdates();

      expect(document.getElementById("table-import-data-type-options")).toBeNull();
      expect(document.getElementById("table-import-generator-options")).toBeTruthy();
    });

    it("当窗口触发 resize 时更新下拉框样式位置", async () => {
      await mountDialogAndGoToStep2();

      const genButtons = [...document.body.querySelectorAll<HTMLElement>("button[data-generator-picker]")];
      const trigger = genButtons[0]!;

      // 打开 generatorPicker
      trigger.click();
      await flushAsyncUpdates();

      const menu = document.getElementById("table-import-generator-options");
      expect(menu).toBeTruthy();

      const scrollParent = trigger.closest(".overflow-auto");
      if (scrollParent) {
        vi.spyOn(scrollParent, "getBoundingClientRect").mockReturnValue({
          top: 0,
          bottom: 1000,
          left: 0,
          right: 1000,
          width: 1000,
          height: 1000,
          x: 0,
          y: 0,
          toJSON: () => {},
        });
      }

      // mock 触发器位置更新
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
        top: 300,
        bottom: 330,
        left: 180,
        right: 280,
        width: 100,
        height: 30,
        x: 180,
        y: 300,
        toJSON: () => {},
      });

      window.dispatchEvent(new Event("resize"));
      await flushAsyncUpdates();

      expect(menu!.style.top).toBe("332px");
      expect(menu!.style.left).toBe("180px");
    });

    it("当触发器滚出可视容器范围时（离屏），自动优雅关闭下拉框", async () => {
      await mountDialogAndGoToStep2();

      const genButtons = [...document.body.querySelectorAll<HTMLElement>("button[data-generator-picker]")];
      const trigger = genButtons[0]!;
      trigger.click();
      await flushAsyncUpdates();

      expect(document.getElementById("table-import-generator-options")).toBeTruthy();

      const scrollParent = trigger.closest(".overflow-auto");
      expect(scrollParent).toBeTruthy();

      // Mock 父容器与触发器的位置，使 triggerRect 完全在 parentRect 之前（滚到上方不可见）
      vi.spyOn(scrollParent!, "getBoundingClientRect").mockReturnValue({
        top: 100,
        bottom: 400,
        left: 0,
        right: 800,
        width: 800,
        height: 300,
        x: 0,
        y: 100,
        toJSON: () => {},
      });

      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
        top: 40,
        bottom: 70, // bottom < parent.top (70 < 100)
        left: 50,
        right: 150,
        width: 100,
        height: 30,
        x: 50,
        y: 40,
        toJSON: () => {},
      });

      // 触发外部滚动事件
      window.dispatchEvent(new Event("scroll"));
      await flushAsyncUpdates();

      // 校验下拉框已自动关闭收起
      expect(document.getElementById("table-import-generator-options")).toBeNull();
    });

    it("当触发器 DOM 节点被销毁脱离文档时，更新位置时自动关闭下拉框", async () => {
      await mountDialogAndGoToStep2();

      const genButtons = [...document.body.querySelectorAll<HTMLElement>("button[data-generator-picker]")];
      const trigger = genButtons[0]!;
      trigger.click();
      await flushAsyncUpdates();

      expect(document.getElementById("table-import-generator-options")).toBeTruthy();

      // 模拟触发器脱离 DOM
      Object.defineProperty(trigger, "isConnected", { value: false, configurable: true });

      window.dispatchEvent(new Event("resize"));
      await flushAsyncUpdates();

      expect(document.getElementById("table-import-generator-options")).toBeNull();
    });
  });
});
