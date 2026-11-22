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

    it("选择 Fixed Value 后 popover 保持打开，输入常量后按钮显示该值 (issue #14503)", async () => {
      await mountDialogAndGoToStep2();

      const genButtons = [...document.body.querySelectorAll<HTMLElement>("button[data-generator-picker]")];
      genButtons[0]!.click();
      await flushAsyncUpdates();

      const menu = document.getElementById("table-import-generator-options")!;
      const fixedOption = [...menu.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find((b) => b.textContent?.trim() === "Fixed Value");
      expect(fixedOption).toBeTruthy();
      fixedOption!.click();
      await flushAsyncUpdates();

      // 选中固定值不关 popover，出现常量输入框
      expect(document.getElementById("table-import-generator-options")).toBeTruthy();
      const input = document.querySelector<HTMLInputElement>("input[data-fixed-value-input]");
      expect(input).toBeTruthy();

      input!.value = "batch-2026";
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      await flushAsyncUpdates();

      expect(genButtons[0]!.textContent).toContain("Fixed Value: batch-2026");

      // 预览列头标记只显示国际化名称，不带用户常量（常量在下方单元格逐行展示）
      const header = [...document.body.querySelectorAll("th")].find((th) => th.textContent?.includes("[Fixed Value]"));
      expect(header).toBeTruthy();
      expect(header!.textContent).not.toContain("batch-2026");
      expect(header!.textContent).not.toContain("fixed:");
      const previewCells = [...document.body.querySelectorAll("td")].filter((td) => td.textContent?.trim() === "batch-2026");
      expect(previewCells.length).toBeGreaterThan(0);

      // 关闭后重新打开，常量仍在输入框中
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flushAsyncUpdates();
      expect(document.getElementById("table-import-generator-options")).toBeNull();

      genButtons[0]!.click();
      await flushAsyncUpdates();
      const reopened = document.querySelector<HTMLInputElement>("input[data-fixed-value-input]");
      expect(reopened?.value).toBe("batch-2026");
    });

    it("固定值输入框在 modal Dialog 下能真正获得焦点（焦点不被抢回对话框）", async () => {
      await mountDialogAndGoToStep2();

      const genButtons = [...document.body.querySelectorAll<HTMLElement>("button[data-generator-picker]")];
      genButtons[0]!.click();
      await flushAsyncUpdates();
      const menu = document.getElementById("table-import-generator-options")!;
      [...menu.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find((b) => b.textContent?.trim() === "Fixed Value")!.click();
      await flushAsyncUpdates();

      const input = document.querySelector<HTMLInputElement>("input[data-fixed-value-input]")!;
      // 模拟用户点击：先让焦点离开，再聚焦输入框；没有 FocusScope 时 modal Dialog 的焦点陷阱会抢回去
      (document.activeElement as HTMLElement | null)?.blur?.();
      input.focus();
      await flushAsyncUpdates();
      expect(document.activeElement).toBe(input);
    });

    it("底部空间不足时 generatorPicker 向上弹出", async () => {
      await mountDialogAndGoToStep2();

      const genButtons = [...document.body.querySelectorAll<HTMLElement>("button[data-generator-picker]")];
      const trigger = genButtons[0]!;
      // 先正常打开（不做 rect mock，否则 scrollParent 可见性检查会误判关闭）
      trigger.click();
      await flushAsyncUpdates();
      const opened = document.getElementById("table-import-generator-options")!;
      expect(opened).toBeTruthy();
      // 再把触发按钮移到视口底部 + 只 mock 菜单元素的高度（全局 mock 会破坏 happy-dom 布局），触发重定位。
      // scrollParent 检查要求触发按钮仍在滚动容器内：容器 rect 一并 mock 到视口底部
      const scrollParent = trigger.closest(".overflow-auto")!;
      vi.spyOn(scrollParent, "getBoundingClientRect").mockReturnValue({ top: window.innerHeight - 100, bottom: window.innerHeight, left: 0, right: 500, width: 500, height: 100, x: 0, y: window.innerHeight - 100, toJSON: () => ({}) });
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ top: window.innerHeight - 50, bottom: window.innerHeight - 22, left: 100, right: 300, width: 200, height: 28, x: 100, y: window.innerHeight - 50, toJSON: () => ({}) });
      const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.id === "table-import-generator-options" ? 200 : 0;
      });
      try {
        window.dispatchEvent(new Event("resize"));
        await flushAsyncUpdates();
        const top = Number.parseFloat(opened.style.top);
        // 向上翻转：菜单底边贴在触发按钮顶边上方，而不是越过视口底部
        expect(top).toBe(window.innerHeight - 50 - 2 - 200);
      } finally {
        offsetHeight.mockRestore();
      }
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
