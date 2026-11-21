// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "vue-i18n";
import SchemaDiffConfigSelector from "@/components/diff/SchemaDiffConfigSelector.vue";
import type { SchemaDiffConfig } from "@/types/schemaDiff";

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
        schemaDiff: {
          selectConfig: "选择配置",
          newConfig: "新建配置",
          newConfigName: "新配置",
          renameConfig: "重命名配置",
          duplicateConfig: "复制配置",
          deleteConfig: "删除配置",
          exportConfig: "导出配置",
          importConfig: "导入配置",
          exportAllConfigs: "导出所有配置",
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

function mountSelector(props: { configs: SchemaDiffConfig[]; activeConfigId: string }) {
  const emitted: Record<string, unknown[][]> = {};
  const host = document.createElement("div");
  document.body.appendChild(host);

  const wrapper = defineComponent({
    setup() {
      return () =>
        h(SchemaDiffConfigSelector, {
          configs: props.configs,
          activeConfigId: props.activeConfigId,
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

describe("SchemaDiffConfigSelector", () => {
  const sampleConfig: SchemaDiffConfig = {
    id: "sd-1",
    name: "测试结构对比",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceConnectionId: "c1",
    sourceDatabase: "db1",
    targetConnectionId: "c2",
    targetDatabase: "db2",
    options: {} as any,
  };

  it("renders rename button with pencil icon and duplicate button with copy icon", () => {
    const { host } = mountSelector({
      configs: [sampleConfig],
      activeConfigId: "sd-1",
    });

    const renameBtn = host.querySelector('[data-testid="schema-diff-config-rename"]') as HTMLButtonElement | null;
    const duplicateBtn = host.querySelector('[data-testid="schema-diff-config-duplicate"]') as HTMLButtonElement | null;
    const createBtn = host.querySelector('[data-testid="schema-diff-config-create"]') as HTMLButtonElement | null;

    expect(createBtn).not.toBeNull();
    expect(createBtn?.title).toBe("新建配置");

    expect(renameBtn).not.toBeNull();
    expect(renameBtn?.title).toBe("重命名配置");
    expect(renameBtn?.getAttribute("aria-label")).toBe("重命名配置");
    expect(renameBtn?.querySelector("svg")).not.toBeNull();
    expect(renameBtn?.querySelector(".lucide-pencil")).not.toBeNull();

    expect(duplicateBtn).not.toBeNull();
    expect(duplicateBtn?.title).toBe("复制配置");
    expect(duplicateBtn?.getAttribute("aria-label")).toBe("复制配置");
    expect(duplicateBtn?.querySelector("svg")).not.toBeNull();
    expect(duplicateBtn?.querySelector(".lucide-copy")).not.toBeNull();
  });

  it("opens rename dialog and emits rename when saved", async () => {
    const { host, emitted } = mountSelector({
      configs: [sampleConfig],
      activeConfigId: "sd-1",
    });

    const renameBtn = host.querySelector('[data-testid="schema-diff-config-rename"]') as HTMLButtonElement;
    expect(renameBtn).not.toBeNull();

    renameBtn.click();
    await nextTick();

    const input = document.body.querySelector('[data-testid="schema-diff-config-rename-input"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.value).toBe("测试结构对比");

    if (input) {
      input.value = "新结构对比名称";
      input.dispatchEvent(new Event("input"));
      await nextTick();
    }

    const saveBtn = document.body.querySelector('[data-testid="schema-diff-config-rename-save"]') as HTMLButtonElement | null;
    expect(saveBtn).not.toBeNull();

    saveBtn?.click();
    await nextTick();

    expect(emitted.rename).toEqual([["sd-1", "新结构对比名称"]]);
  });

  it("emits duplicate with config id when duplicate button is clicked", () => {
    const { host, emitted } = mountSelector({
      configs: [sampleConfig],
      activeConfigId: "sd-1",
    });

    const duplicateBtn = host.querySelector('[data-testid="schema-diff-config-duplicate"]') as HTMLButtonElement;
    duplicateBtn.click();

    expect(emitted.duplicate).toEqual([["sd-1"]]);
  });
});
