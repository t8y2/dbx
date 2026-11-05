// @vitest-environment happy-dom
// MCP 授权设置页签：四个区块是同一份暂存策略的独立视图，不是线性流程，
// 因此不再有“上一步/下一步/第 N 步”，而是可直达的页签。
// 1) 四个页签可直达，默认选中“默认权限”。
// 2) 切换页签只改变可见面板；所有面板保持挂载（子组件的搜索/展开状态不丢）。
// 3) 不再渲染流程式的上一步/下一步/进度控件。

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

import McpAuthorizationTabs from "@/components/settings/McpAuthorizationTabs.vue";

const SECTIONS = ["overrides", "connections", "databases", "capabilities"] as const;

let harness: { app: App<Element>; root: HTMLElement } | null = null;

function mountTabs() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = createApp({
    components: { McpAuthorizationTabs },
    template: `
      <McpAuthorizationTabs>
        <template #overrides><p data-slot-content="overrides">overrides</p></template>
        <template #connections><p data-slot-content="connections">connections</p></template>
        <template #databases><p data-slot-content="databases">databases</p></template>
        <template #capabilities><p data-slot-content="capabilities">capabilities</p></template>
      </McpAuthorizationTabs>
    `,
  });
  app.mount(root);
  harness = { app, root };
  return root;
}

afterEach(() => {
  harness?.app?.unmount();
  harness = null;
  document.body.innerHTML = "";
});

function triggers(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>('[role="tab"]'));
}

function panelOf(root: HTMLElement, section: string) {
  const content = root.querySelector(`[data-slot-content="${section}"]`);
  const panel = content?.closest<HTMLElement>('[role="tabpanel"]');
  if (!panel) throw new Error(`panel ${section} not found`);
  return panel;
}

async function selectTab(tab: HTMLElement) {
  // reka-ui 的触发器在 mousedown / focus 时激活，而不是 click。
  tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ctrlKey: false }));
  await nextTick();
}

describe("McpAuthorizationTabs", () => {
  it("渲染四个页签，默认选中第一个", () => {
    const root = mountTabs();

    const tabs = triggers(root);
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(["settings.mcpAuthTabOverridesTitle", "settings.mcpAuthTabConnectionsTitle", "settings.mcpAuthTabDatabasesTitle", "settings.mcpAuthTabCapabilitiesTitle"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(panelOf(root, "overrides").hidden).toBe(false);
    expect(panelOf(root, "databases").hidden).toBe(true);
  });

  it("每个页签都能直达，且只显示被选中的面板", async () => {
    const root = mountTabs();

    for (const [index, section] of SECTIONS.entries()) {
      await selectTab(triggers(root)[index]);
      expect(triggers(root)[index].getAttribute("aria-selected")).toBe("true");
      for (const other of SECTIONS) {
        // data-state 由选中态直接驱动；hidden 经由 Presence 判定，happy-dom 下没有动画事件，故不以它为准。
        expect(panelOf(root, other).getAttribute("data-state"), `${section} selected, ${other}`).toBe(other === section ? "active" : "inactive");
      }
    }
  });

  it("所有面板始终保持挂载", async () => {
    const root = mountTabs();
    await selectTab(triggers(root)[2]);

    for (const section of SECTIONS) {
      expect(root.querySelector(`[data-slot-content="${section}"]`), section).not.toBeNull();
    }
  });

  it("不再渲染上一步/下一步/进度等流程控件", () => {
    const root = mountTabs();

    expect(root.querySelector("footer")).toBeNull();
    expect(root.textContent).not.toMatch(/PreviousStep|NextStep|StepProgress/);
  });
});
