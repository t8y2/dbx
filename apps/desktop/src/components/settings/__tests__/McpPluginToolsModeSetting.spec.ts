// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import McpPluginToolsModeSetting from "../McpPluginToolsModeSetting.vue";
import { normalizeMcpGlobalPolicy, type McpGlobalPolicy } from "@/stores/settingsStore";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function mountSetting(initial: Partial<McpGlobalPolicy> = {}, disabled = false) {
  const props = reactive({ modelValue: normalizeMcpGlobalPolicy(initial).pluginToolsMode, disabled });
  const update = vi.fn((value: McpGlobalPolicy["pluginToolsMode"]) => {
    props.modelValue = value;
  });
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp({ render: () => h(McpPluginToolsModeSetting, { ...props, "onUpdate:modelValue": update }) });
  app.mount(root);
  cleanups.push(() => {
    app.unmount();
    root.remove();
  });
  const details = root.querySelector<HTMLDetailsElement>("details")!;
  const trigger = root.querySelector<HTMLButtonElement>("[data-mcp-plugin-tools-mode-trigger]")!;
  async function choose(label: string) {
    details.open = true;
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(3));
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((item) => item.textContent?.trim() === label)!;
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await nextTick();
    await vi.waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
  }
  return { props, update, root, details, trigger, choose };
}

describe("McpPluginToolsModeSetting", () => {
  it("starts collapsed with the flat default and changes modes using the real select", async () => {
    const { root, details, props, update, choose } = mountSetting();
    expect(details.open).toBe(false);
    expect(root.querySelector("summary")!.textContent).toContain("settings.mcpPluginToolsModeFlat");
    expect(update).not.toHaveBeenCalled();
    await choose("settings.mcpPluginToolsModeLazy");
    expect(props.modelValue).toBe("lazy");
    expect(root.querySelector("#mcp-plugin-tools-mode-description")!.textContent).toBe("settings.mcpPluginToolsModeLazyDescription");
    await choose("settings.mcpPluginToolsModeFlat");
    expect(props.modelValue).toBe("flat");
    expect(update.mock.calls.map(([value]) => value)).toEqual(["lazy", "flat"]);
  });

  it.each(["auto", "flat", "lazy"] as const)("preserves saved %s mode on mount and while collapsing the setting", async (pluginToolsMode) => {
    const { props, update, details, root } = mountSetting({ configured: true, pluginToolsMode });
    expect(props.modelValue).toBe(pluginToolsMode);
    const label = { auto: "Auto", flat: "Flat", lazy: "Lazy" }[pluginToolsMode];
    expect(root.querySelector("summary")!.textContent).toContain(`settings.mcpPluginToolsMode${label}`);
    details.open = true;
    await nextTick();
    details.open = false;
    await nextTick();
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps automatic mode available as an explicit compatibility choice", async () => {
    const { choose, props, root } = mountSetting({ configured: true, pluginToolsMode: "auto" });
    await choose("settings.mcpPluginToolsModeLazy");
    await choose("settings.mcpPluginToolsModeAuto");
    expect(props.modelValue).toBe("auto");
    expect(root.querySelector("#mcp-plugin-tools-mode-description")!.textContent).toBe("settings.mcpPluginToolsModeAutoDescription");
  });

  it("disables changes while policy loading or saving prevents editing", async () => {
    const { trigger, details, update } = mountSetting({}, true);
    details.open = true;
    expect(trigger.disabled).toBe(true);
    trigger.click();
    await nextTick();
    expect(document.querySelector('[role="option"]')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});
