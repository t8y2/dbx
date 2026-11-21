// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpResultProtectionPolicy, resultProtectionScopeKey, resultProtectionTemplate, type ResultProtectionScope } from "@/lib/mcp/mcpResultProtection";

const preview = vi.hoisted(() => vi.fn());
const listDatabases = vi.hoisted(() => vi.fn(async () => [{ name: "app" }, { name: "private" }]));
vi.mock("@/lib/backend/api", () => ({ previewMcpResultProtection: preview, listDatabases }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, params?: unknown) => `${key}${params ? JSON.stringify(params) : ""}` }) }));

import McpResultProtectionEditor from "@/components/settings/McpResultProtectionEditor.vue";

const cleanups: (() => void)[] = [];
beforeEach(() => {
  Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: () => true });
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function mount(disabled = false, savePolicy = vi.fn(async () => {})) {
  const container = document.createElement("div");
  document.body.append(container);
  const props = reactive({
    policy: createMcpResultProtectionPolicy(),
    connections: [{ id: "connection", name: "Production", db_type: "postgres" as const }],
    layout: { groups: [{ id: "group", name: "Team", collapsed: false }], order: [{ type: "group" as const, id: "group", children: [{ type: "connection" as const, id: "connection" }] }] },
    allowedConnectionIds: [] as string[] | null,
    allowedGroupIds: ["group"],
    connectionPolicies: [{ connectionId: "connection", databaseScope: "selected" as "all" | "selected" | "none", allowedDatabases: ["app"] }],
    disabled,
    savePolicy,
  });
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
  async function select(scope: ResultProtectionScope) {
    const selector = element<HTMLSelectElement>("#mcp-result-scope");
    selector.value = resultProtectionScopeKey(scope);
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  }
  async function state(value: string) {
    const selector = element<HTMLSelectElement>("[data-protection-state]");
    selector.value = value;
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  }
  return { container, props, element, savePolicy, select, state };
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
    preview.mockResolvedValue({ status: "disabled", hits: [], source: { kind: "global" } });
    const mounted = mount();
    mounted.element<HTMLButtonElement>("[data-protection-template]").click();
    await flush();
    mounted.element<HTMLButtonElement>("[data-protection-test]").click();
    await flush();
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ column: "phone", value: "13800001234", policy: expect.objectContaining({ default: expect.objectContaining({ enabled: false }) }) }));
    expect(mounted.element<HTMLInputElement>("[data-protection-enabled]").checked).toBe(false);
    expect(mounted.savePolicy).not.toHaveBeenCalled();
    expect(mounted.element("[data-protection-preview]").textContent).toContain("settings.mcpResultPreviewStatusDisabled");
    expect(mounted.element("[data-protection-after]").textContent).toBe('"13800001234"');
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

  it("copies effective parent rules without enabling and confirms restoring inheritance", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const mounted = mount();
    mounted.element<HTMLButtonElement>("[data-protection-template]").click();
    await flush();
    await mounted.select({ kind: "group", groupId: "group" });
    mounted.element<HTMLButtonElement>("[data-protection-customize]").click();
    await flush();
    expect(mounted.element<HTMLSelectElement>("[data-protection-state]").value).toBe("disabled");
    await mounted.state("enabled");
    await mounted.select({ kind: "connection", connectionId: "connection" });
    expect(listDatabases).toHaveBeenCalledWith("connection");
    expect(mounted.element<HTMLSelectElement>("#mcp-result-scope").textContent).not.toContain("private");
    await mounted.select({ kind: "database", connectionId: "connection", database: "app" });
    mounted.element<HTMLButtonElement>("[data-protection-customize]").click();
    await flush();
    expect(mounted.element<HTMLSelectElement>("[data-protection-state]").value).toBe("enabled");
    await mounted.state("disabled");
    expect(mounted.container.querySelectorAll("[data-protection-rule]")).toHaveLength(4);
    mounted.element<HTMLButtonElement>("[data-protection-save]").click();
    await flush();
    expect(mounted.savePolicy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        default: expect.objectContaining({ enabled: false }),
        groupOverrides: [expect.objectContaining({ groupId: "group", settings: expect.objectContaining({ enabled: true }) })],
        overrides: [expect.objectContaining({ connectionId: "connection", database: "app", settings: expect.objectContaining({ enabled: false }) })],
      }),
    );
    await mounted.state("inherit");
    expect(confirm).toHaveBeenCalled();
    expect(mounted.element<HTMLSelectElement>("[data-protection-state]").value).toBe("disabled");
    confirm.mockReturnValue(true);
    await mounted.state("inherit");
    mounted.element<HTMLButtonElement>("[data-protection-save]").click();
    await flush();
    expect(mounted.savePolicy).toHaveBeenLastCalledWith(expect.objectContaining({ overrides: [] }));
  });

  it("rejects enabling an empty policy and clearing enabled rules blocks saving", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const mounted = mount();
    const enabled = mounted.element<HTMLInputElement>("[data-protection-enabled]");
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(enabled.checked).toBe(false);
    expect(mounted.element("[role=alert]").textContent).toContain("settings.mcpResultEmptyEnabled");
    mounted.element<HTMLButtonElement>("[data-protection-template]").click();
    await flush();
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    mounted.element<HTMLButtonElement>("[data-protection-clear]").click();
    await flush();
    expect(enabled.checked).toBe(true);
    mounted.element<HTMLButtonElement>("[data-protection-save]").click();
    await flush();
    expect(mounted.savePolicy).not.toHaveBeenCalled();
    expect(mounted.element("[role=alert]").textContent).toContain("settings.mcpResultEmptyEnabled");
  });

  it("uses explicit JSON parsing and rejects invalid JSON without a backend request", async () => {
    preview.mockResolvedValue({ status: "protected", value: null, hits: [], source: { kind: "global" } });
    const mounted = mount();
    const format = mounted.element<HTMLSelectElement>("[data-protection-sample-format]");
    format.value = "json";
    format.dispatchEvent(new Event("change", { bubbles: true }));
    const value = mounted.element<HTMLTextAreaElement>("#mcp-sample-value");
    value.value = "null";
    value.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    mounted.element<HTMLButtonElement>("[data-protection-test]").click();
    await flush();
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ value: null }));
    expect(mounted.element("[data-protection-after]").textContent).toBe("null");
    value.value = "{broken";
    value.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    mounted.element<HTMLButtonElement>("[data-protection-test]").click();
    await flush();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(mounted.element("[role=alert]").textContent).toContain("settings.mcpResultPreviewInvalidJson");
  });

  it("invalidates pending previews when the sample or selected scope changes", async () => {
    let complete!: (value: unknown) => void;
    preview.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const mounted = mount();
    mounted.element<HTMLButtonElement>("[data-protection-test]").click();
    await flush();
    const value = mounted.element<HTMLTextAreaElement>("#mcp-sample-value");
    value.value = "changed";
    value.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    complete({ status: "protected", value: "stale result", hits: [], source: { kind: "global" } });
    await flush();
    expect(mounted.container.querySelector("[data-protection-preview]")).toBeNull();
    mounted.element<HTMLButtonElement>("[data-protection-test]").click();
    await flush();
    await mounted.select({ kind: "group", groupId: "group" });
    complete({ status: "protected", value: "stale scope", hits: [], source: { kind: "global" } });
    await flush();
    expect(mounted.container.querySelector("[data-protection-preview]")).toBeNull();
  });

  it.each(["removed", "denied"])("shows %s without rendering returned data", async (status) => {
    preview.mockResolvedValue({ status, value: "DO-NOT-DISPLAY", hits: [{ column: "phone", ruleId: "phone", action: status === "removed" ? "remove" : "deny" }], source: { kind: "global" } });
    const mounted = mount();
    mounted.element<HTMLButtonElement>("[data-protection-test]").click();
    await flush();
    expect(mounted.element("[data-protection-preview]").textContent).not.toContain("DO-NOT-DISPLAY");
    expect(mounted.container.querySelector("tbody")?.textContent).toContain("phone");
  });

  it("uses safe preview errors and sends group selection ancestry without saving", async () => {
    preview.mockRejectedValue(new Error("secret-from-server"));
    const mounted = mount();
    await mounted.select({ kind: "group", groupId: "group" });
    mounted.element<HTMLButtonElement>("[data-protection-test]").click();
    await flush();
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "", database: "", groupIds: ["group"] }));
    expect(mounted.element("[role=alert]").textContent).not.toContain("secret-from-server");
    expect(mounted.savePolicy).not.toHaveBeenCalled();
  });

  it("keeps inactive configuration editable without broadening authorization", async () => {
    const mounted = mount();
    mounted.props.policy.overrides.push({ connectionId: "missing", database: "old", settings: { enabled: false, mode: "strict", rules: resultProtectionTemplate() } });
    await flush();
    const authorization = JSON.stringify([mounted.props.allowedConnectionIds, mounted.props.allowedGroupIds, mounted.props.connectionPolicies]);
    await mounted.select({ kind: "database", connectionId: "missing", database: "old" });
    expect(mounted.container.textContent).toContain("settings.mcpResultInactive");
    expect(mounted.container.querySelectorAll("[data-protection-rule]")).toHaveLength(4);
    await mounted.state("enabled");
    mounted.element<HTMLButtonElement>("[data-protection-save]").click();
    await flush();
    expect(mounted.savePolicy).toHaveBeenLastCalledWith(expect.objectContaining({ overrides: [expect.objectContaining({ connectionId: "missing", database: "old", settings: expect.objectContaining({ enabled: true }) })] }));
    expect(JSON.stringify([mounted.props.allowedConnectionIds, mounted.props.allowedGroupIds, mounted.props.connectionPolicies])).toBe(authorization);
    expect(listDatabases).not.toHaveBeenCalled();
  });

  it("counts enabled descendants under an off parent and preserves their source", async () => {
    const mounted = mount();
    mounted.props.policy.groupOverrides = [{ groupId: "group", settings: { enabled: true, mode: "strict", rules: resultProtectionTemplate() } }];
    await flush();
    expect(mounted.element("[data-protection-exceptions]").textContent).toContain('"count":1');
    await mounted.select({ kind: "connection", connectionId: "connection" });
    expect(mounted.element("[data-protection-source]").textContent).toContain("Team");
    expect(mounted.element<HTMLSelectElement>("[data-protection-state]").value).toBe("inherit");
  });

  it("refreshes actual database choices and hides all database choices when access is none", async () => {
    const mounted = mount();
    expect(listDatabases).not.toHaveBeenCalled();
    await mounted.select({ kind: "connection", connectionId: "connection" });
    expect(listDatabases).toHaveBeenCalledTimes(1);
    mounted.props.connectionPolicies[0].databaseScope = "all";
    await flush();
    expect(mounted.element<HTMLSelectElement>("#mcp-result-scope").textContent).toContain("private");
    mounted.element<HTMLButtonElement>("[data-protection-database-refresh]").click();
    await flush();
    expect(listDatabases).toHaveBeenCalledTimes(2);
    mounted.props.connectionPolicies[0].databaseScope = "none";
    await flush();
    expect(mounted.element<HTMLSelectElement>("#mcp-result-scope").textContent).not.toContain("private");
    expect(mounted.container.querySelector("[data-protection-database-refresh]")).toBeNull();
  });

  it("invalidates results after rule edits and keeps text unchanged for a nonmatching sample", async () => {
    preview.mockResolvedValue({ status: "unchanged", hits: [], source: { kind: "global" } });
    const mounted = mount();
    mounted.element<HTMLButtonElement>("[data-protection-test]").click();
    await flush();
    expect(mounted.element("[data-protection-after]").textContent).toBe('"13800001234"');
    mounted.element<HTMLButtonElement>("[data-protection-template]").click();
    await flush();
    expect(mounted.container.querySelector("[data-protection-preview]")).toBeNull();
    expect(mounted.savePolicy).not.toHaveBeenCalled();
  });
});
