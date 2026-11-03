// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import McpCallSafetyPanel from "../McpCallSafetyPanel.vue";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
function mount(mode: "off" | "full" | "high_risk", disabled = false) {
  const props = reactive({ mode, disabled });
  const change = vi.fn((enabled: boolean) => {
    props.mode = enabled ? "high_risk" : "off";
  });
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp({ render: () => h(McpCallSafetyPanel, { ...props, "onSet:confirmation": change }) });
  app.mount(root);
  cleanup.push(() => {
    app.unmount();
    root.remove();
  });
  return { root, change, props };
}

it("shows a separate collapsed policy and allows enabling and disabling confirmation", async () => {
  const { root, change } = mount("off");
  expect(root.querySelector("details")!.open).toBe(false);
  root.querySelector("details")!.open = true;
  const input = root.querySelector<HTMLInputElement>("input")!;
  expect(input.checked).toBe(false);
  expect(document.getElementById(input.getAttribute("aria-describedby")!)!.textContent).toContain("mcpCallSafetyHint");
  input.click();
  await nextTick();
  expect(change).toHaveBeenLastCalledWith(true);
  expect(root.textContent).toContain("mcpCallSafetyEnabled");
  input.click();
  await nextTick();
  expect(change).toHaveBeenLastCalledWith(false);
});

it.each([true, false])("explains legacy behavior and changes it only on an explicit choice: %s", async (enable) => {
  const { root, change } = mount("full");
  expect(root.querySelector("details")!.open).toBe(true);
  expect(root.querySelector("input")).toBeNull();
  expect(root.textContent).toContain("mcpCallSafetyLegacyHint");
  expect(root.textContent).not.toContain("settings.mcpCallSafetyHint");
  expect(root.textContent).not.toContain("settings.mcpCallSafetyDesktopHint");
  expect(change).not.toHaveBeenCalled();
  root.querySelector<HTMLButtonElement>(enable ? "[data-mcp-safety-migrate]" : "[data-mcp-safety-disable-legacy]")!.click();
  await nextTick();
  expect(change).toHaveBeenCalledExactlyOnceWith(enable);
  expect(root.querySelector<HTMLInputElement>("input")!.checked).toBe(enable);
  expect(root.querySelector("[data-mcp-safety-legacy]")).toBeNull();
  expect(root.textContent).toContain("settings.mcpCallSafetyHint");
  expect(root.textContent).toContain("settings.mcpCallSafetyDesktopHint");
  expect(root.querySelector("details")!.open).toBe(true);
  expect(document.activeElement).toBe(root.querySelector("input"));
});

it.each(["off", "full", "high_risk"] as const)("locks safety controls while saving or loading: %s", async (mode) => {
  const { root, change } = mount(mode, true);
  for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) {
    expect(control.disabled).toBe(true);
    control.click();
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }
  await nextTick();
  expect(change).not.toHaveBeenCalled();
});
