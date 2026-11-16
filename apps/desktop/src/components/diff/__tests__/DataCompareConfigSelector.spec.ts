// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "vue-i18n";
import DataCompareConfigSelector from "@/components/diff/DataCompareConfigSelector.vue";
import type { DataCompareConfig } from "@/composables/useDataCompareConfig";

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: "zh-CN",
    messages: {
      "zh-CN": {
        dataCompare: {
          configSelect: "选择配置",
          configTableCount: "{count} 张表",
          configNew: "新建配置",
          configRename: "重命名配置",
          configDuplicate: "复制配置",
          configDelete: "删除配置",
          configName: "配置名称",
        },
        common: {
          cancel: "取消",
          save: "保存",
        },
      },
    },
    missingWarn: false,
    fallbackWarn: false,
  });
}

function mountSelector(props: { configs: DataCompareConfig[]; activeConfigId: string; disabled?: boolean }) {
  const emitted: Record<string, unknown[][]> = {};
  const host = document.createElement("div");
  document.body.appendChild(host);

  const wrapper = defineComponent({
    setup() {
      return () =>
        h(DataCompareConfigSelector, {
          configs: props.configs,
          activeConfigId: props.activeConfigId,
          disabled: props.disabled,
          "onUpdate:activeConfigId": (...args: unknown[]) => {
            (emitted["update:activeConfigId"] ??= []).push(args);
          },
          onCreate: (...args: unknown[]) => {
            (emitted.create ??= []).push(args);
          },
          onRename: (...args: unknown[]) => {
            (emitted.rename ??= []).push(args);
          },
          onDuplicate: (...args: unknown[]) => {
            (emitted.duplicate ??= []).push(args);
          },
          onDelete: (...args: unknown[]) => {
            (emitted.delete ??= []).push(args);
          },
        });
    },
  });

  const app = createApp(wrapper);
  app.use(createTestI18n());
  app.mount(host);
  mountedApps.push(app);

  return { host, emitted };
}

describe("DataCompareConfigSelector", () => {
  const sampleConfig: DataCompareConfig = {
    id: "cfg-1",
    name: "测试数据对比",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceConnectionId: "c1",
    sourceDatabase: "db1",
    sourceSchema: "public",
    selectedSourceTables: ["users"],
    targetConnectionId: "c2",
    targetDatabase: "db2",
    targetSchema: "public",
    targetTable: "users",
    detailPreviewLimit: "100",
    keyColumnsByTable: {},
  };

  it("renders rename button with pencil icon and duplicate button with copy icon", () => {
    const { host } = mountSelector({
      configs: [sampleConfig],
      activeConfigId: "cfg-1",
    });

    const renameBtn = host.querySelector('[data-testid="data-compare-config-rename"]') as HTMLButtonElement | null;
    const duplicateBtn = host.querySelector('[data-testid="data-compare-config-duplicate"]') as HTMLButtonElement | null;
    const createBtn = host.querySelector('[data-testid="data-compare-config-create"]') as HTMLButtonElement | null;
    const deleteBtn = host.querySelector('[data-testid="data-compare-config-delete"]') as HTMLButtonElement | null;

    expect(createBtn).not.toBeNull();
    expect(createBtn?.title).toBe("新建配置");

    expect(renameBtn).not.toBeNull();
    expect(renameBtn?.title).toBe("重命名配置");
    expect(renameBtn?.getAttribute("aria-label")).toBe("重命名配置");
    // Pencil icon class/svg is present in rename button
    expect(renameBtn?.querySelector("svg")).not.toBeNull();
    expect(renameBtn?.querySelector(".lucide-pencil")).not.toBeNull();

    expect(duplicateBtn).not.toBeNull();
    expect(duplicateBtn?.title).toBe("复制配置");
    expect(duplicateBtn?.getAttribute("aria-label")).toBe("复制配置");
    // Copy icon class/svg is present in duplicate button
    expect(duplicateBtn?.querySelector("svg")).not.toBeNull();
    expect(duplicateBtn?.querySelector(".lucide-copy")).not.toBeNull();

    expect(deleteBtn).not.toBeNull();
    expect(deleteBtn?.title).toBe("删除配置");
  });

  it("opens rename dialog and emits rename when saved", async () => {
    const { host, emitted } = mountSelector({
      configs: [sampleConfig],
      activeConfigId: "cfg-1",
    });

    const renameBtn = host.querySelector('[data-testid="data-compare-config-rename"]') as HTMLButtonElement;
    expect(renameBtn).not.toBeNull();

    renameBtn.click();
    await nextTick();

    const input = document.body.querySelector('[data-testid="data-compare-config-rename-input"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.value).toBe("测试数据对比");

    if (input) {
      input.value = "新配置名称";
      input.dispatchEvent(new Event("input"));
      await nextTick();
    }

    const saveBtn = document.body.querySelector('[data-testid="data-compare-config-rename-save"]') as HTMLButtonElement | null;
    expect(saveBtn).not.toBeNull();

    saveBtn?.click();
    await nextTick();

    expect(emitted.rename).toEqual([["cfg-1", "新配置名称"]]);
  });

  it("emits duplicate with config id when duplicate button is clicked", () => {
    const { host, emitted } = mountSelector({
      configs: [sampleConfig],
      activeConfigId: "cfg-1",
    });

    const duplicateBtn = host.querySelector('[data-testid="data-compare-config-duplicate"]') as HTMLButtonElement;
    duplicateBtn.click();

    expect(emitted.duplicate).toEqual([["cfg-1"]]);
  });

  it("emits create when create button is clicked", () => {
    const { host, emitted } = mountSelector({
      configs: [sampleConfig],
      activeConfigId: "cfg-1",
    });

    const createBtn = host.querySelector('[data-testid="data-compare-config-create"]') as HTMLButtonElement;
    createBtn.click();

    expect(emitted.create).toHaveLength(1);
  });
});
