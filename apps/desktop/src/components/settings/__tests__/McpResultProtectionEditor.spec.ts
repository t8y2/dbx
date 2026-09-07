// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpResultProtectionPolicy, resultProtectionTemplate } from "@/lib/mcp/mcpResultProtection";

const preview = vi.hoisted(() => vi.fn());
vi.mock("@/lib/backend/api", () => ({ previewMcpResultProtection: preview }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, params?: unknown) => `${key}${params ? JSON.stringify(params) : ""}` }) }));

import McpResultProtectionEditor from "@/components/settings/McpResultProtectionEditor.vue";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.clearAllMocks();
});

function mount(disabled = false, savePolicy = vi.fn(async () => {})) {
  const container = document.createElement("div");
  document.body.append(container);
  const props = reactive({ policy: createMcpResultProtectionPolicy(), connections: [{ id: "connection", name: "Production" }], disabled, savePolicy });
  const app = createApp({ render: () => h(McpResultProtectionEditor, props) });
  app.mount(container);
  cleanups.push(() => {
    app.unmount();
    container.remove();
  });
  function element<T extends HTMLElement>(selector: string): T {
    const element = container.querySelector<T>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  }
  return { container, props, element, savePolicy };
}

async function flush() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

describe("McpResultProtectionEditor", () => {
  it("requires explicit template, enable and save actions", async () => {
    const mounted = mount();
    mounted.element<HTMLButtonElement>("[data-protection-template]").click();
    await flush();
    expect(mounted.container.querySelectorAll("[data-protection-rule]")).toHaveLength(4);
    const enabled = mounted.element<HTMLInputElement>("[data-protection-enabled]");
    expect(enabled.checked).toBe(false);
    expect(mounted.props.policy.default.rules).toEqual([]);
    expect(mounted.savePolicy).not.toHaveBeenCalled();
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    mounted.element<HTMLButtonElement>("[data-protection-save]").click();
    await flush();
    expect(mounted.savePolicy).toHaveBeenCalledWith(expect.objectContaining({ default: { enabled: true, mode: "strict", rules: resultProtectionTemplate() } }));
  });

  it("keeps failed drafts editable and displays the server validation error", async () => {
    const mounted = mount(
      false,
      vi.fn(async () => {
        throw new Error("MCP_RESULT_POLICY_INVALID");
      }),
    );
    mounted.element<HTMLButtonElement>("[data-protection-template]").click();
    await flush();
    mounted.element<HTMLButtonElement>("[data-protection-save]").click();
    await flush();
    expect(mounted.element("[role=alert]").textContent).toContain("MCP_RESULT_POLICY_INVALID");
    expect(mounted.container.querySelectorAll("[data-protection-rule]")).toHaveLength(4);
    expect(mounted.element<HTMLButtonElement>("[data-protection-save]").disabled).toBe(false);
  });

  it("tests unsaved rules on the backend without enabling or persisting them", async () => {
    preview.mockResolvedValue([{ ruleId: "phone", column: "phone", action: "partial" }]);
    const mounted = mount();
    mounted.element<HTMLButtonElement>("[data-protection-template]").click();
    await flush();
    mounted.element<HTMLButtonElement>("[data-protection-test]").click();
    await flush();
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ column: "phone", value: 13800001234, policy: expect.objectContaining({ default: expect.objectContaining({ enabled: true }) }) }));
    expect(mounted.element<HTMLInputElement>("[data-protection-enabled]").checked).toBe(false);
    expect(mounted.savePolicy).not.toHaveBeenCalled();
    expect(mounted.container.querySelector("tbody")?.textContent).toContain("phone");
  });

  it("blocks editing while the policy is unavailable", async () => {
    const mounted = mount(true);
    mounted.element<HTMLButtonElement>("[data-protection-template]").click();
    await flush();
    expect(mounted.container.querySelectorAll("[data-protection-rule]")).toHaveLength(0);
    expect(mounted.element<HTMLFieldSetElement>("fieldset").disabled).toBe(true);
    expect(mounted.element<HTMLButtonElement>("[data-protection-save]").disabled).toBe(true);
    expect(mounted.savePolicy).not.toHaveBeenCalled();
  });

  it("inherits connection settings for database overrides and removes overrides explicitly", async () => {
    const mounted = mount();
    mounted.element<HTMLButtonElement>("[data-protection-template]").click();
    const connection = mounted.element<HTMLSelectElement>("#mcp-result-connection");
    connection.value = "connection";
    connection.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    mounted.element<HTMLButtonElement>('[aria-label="settings.mcpResultOverride"]').click();
    await flush();
    const enabled = mounted.element<HTMLInputElement>("[data-protection-enabled]");
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    const database = mounted.element<HTMLInputElement>("#mcp-result-database");
    database.value = "app";
    database.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    mounted.element<HTMLButtonElement>('[aria-label="settings.mcpResultOverride"]').click();
    await flush();
    expect(mounted.element<HTMLInputElement>("[data-protection-enabled]").checked).toBe(true);
    mounted.element<HTMLButtonElement>("[data-protection-save]").click();
    await flush();
    expect(mounted.savePolicy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        default: expect.objectContaining({ enabled: false }),
        overrides: [expect.objectContaining({ connectionId: "connection", database: null, settings: expect.objectContaining({ enabled: true }) }), expect.objectContaining({ connectionId: "connection", database: "app", settings: expect.objectContaining({ enabled: true }) })],
      }),
    );
    mounted.element<HTMLButtonElement>('[aria-label="settings.mcpResultInherit"]').click();
    await flush();
    mounted.element<HTMLButtonElement>("[data-protection-save]").click();
    await flush();
    expect(mounted.savePolicy).toHaveBeenLastCalledWith(expect.objectContaining({ overrides: [expect.objectContaining({ database: null })] }));
  });
});
