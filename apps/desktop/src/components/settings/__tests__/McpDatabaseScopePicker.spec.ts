// @vitest-environment happy-dom
// MCP 数据库范围选择器回归测试：
// 加载资源列表前先 ensureConnected（修复未连接的 SQL 连接报 Connection not found）。
// 1) 正常流程：选择“仅指定数据库”→ 手工添加库名 → emit 携带 allowedDatabases。
// 2) busy/disabled 期间手工添加被整体拦截，库名不再进入本地列表（修复静默丢失）。
// 3) 重开对话框后已持久化的 allowedDatabases 重新显示并勾选（修复不回显）。

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listDatabases: vi.fn(),
  mongoListDatabases: vi.fn(),
  redisListDatabases: vi.fn(),
  ensureConnected: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params?.error === undefined ? key : `${key}:${String(params.error)}`) }) }));
vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  mongoListDatabases: mocks.mongoListDatabases,
  redisListDatabases: mocks.redisListDatabases,
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ ensureConnected: mocks.ensureConnected }),
}));
vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const Icon = defineComponent({ setup: () => () => h("i") });
  return { Check: Icon, ChevronLeft: Icon, ChevronRight: Icon, Loader2: Icon, Plus: Icon, RefreshCw: Icon, Search: Icon };
});

async function passthroughComponent() {
  const { defineComponent, h } = await import("vue");
  return defineComponent({
    inheritAttrs: false,
    setup:
      (_, { slots, attrs }) =>
      () =>
        h("div", { ...attrs }, slots.default?.()),
  });
}
vi.mock("@/components/ui/button", async () => ({ Button: await passthroughComponent() }));
vi.mock("@/components/ui/badge", async () => ({ Badge: await passthroughComponent() }));
vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  const Input = defineComponent({
    props: ["modelValue"],
    emits: ["update:modelValue"],
    setup:
      (props, { emit, attrs }) =>
      () =>
        h("input", {
          ...attrs,
          value: props.modelValue,
          onInput: (e: Event) => emit("update:modelValue", (e.target as HTMLInputElement).value),
          onKeydown: (e: KeyboardEvent) => {
            if (e.key === "Enter") {
              e.preventDefault();
              attrs.onKeydownEnter?.(e);
            }
          },
        }),
  });
  return { Input };
});

import McpDatabaseScopePicker from "@/components/settings/McpDatabaseScopePicker.vue";
import type { McpConnectionPolicy } from "@/stores/settingsStore";
import type { ConnectionConfig } from "@/types/database";

function fakeConnection(id: string): ConnectionConfig {
  return { id, name: `conn-${id}`, db_type: "oracle" } as unknown as ConnectionConfig;
}

function emptyPolicy(connectionId: string, scope: McpConnectionPolicy["databaseScope"] = "all"): McpConnectionPolicy {
  return {
    connectionId,
    readOnly: false,
    allowDangerousSql: false,
    executionModeConfigured: false,
    executionModePolicyVersion: null,
    databaseScope: scope,
    allowedDatabases: [],
    databasePolicies: [],
  };
}

function mountHarness(policies: McpConnectionPolicy[], disabled = false) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const emitted = { policies: [] as McpConnectionPolicy[][] };
  const app = createApp(McpDatabaseScopePicker, {
    connections: [fakeConnection("oracle-1")],
    allowedConnectionIds: null,
    connectionPolicies: policies,
    disabled,
    busy: false,
    "onUpdate:connectionPolicies": (next: McpConnectionPolicy[]) => emitted.policies.push(next),
  });
  app.mount(root);
  harness = { app, root };
  return { app, emitted, root };
}

let harness: { app: App<Element>; root: HTMLElement } | null = null;

beforeEach(() => {
  mocks.ensureConnected.mockReset().mockResolvedValue(undefined);
  mocks.listDatabases.mockReset().mockResolvedValue([{ name: "LOADED_DB" }]);
});
afterEach(() => {
  harness?.app?.unmount();
  harness = null;
  document.body.innerHTML = "";
});

function clickScopeRadio(root: HTMLElement, scope: string) {
  const radio = Array.from(root.querySelectorAll("[data-database-scope]")).find((el) => el.getAttribute("data-database-scope") === scope);
  if (!radio) throw new Error(`scope radio ${scope} not found`);
  radio.dispatchEvent(new MouseEvent("click"));
}

function manualInput(root: HTMLElement): HTMLInputElement {
  const input = Array.from(root.querySelectorAll("input")).find((i) => i.placeholder === "settings.mcpDatabaseManualPlaceholder");
  if (!input) throw new Error("manual input not found");
  return input as HTMLInputElement;
}

function loadButton(root: HTMLElement): HTMLElement {
  const candidates = Array.from(root.querySelectorAll("div,button")).filter((el) => el.textContent?.includes("settings.mcpDatabaseLoadButton"));
  const deepest = candidates.at(-1);
  if (!deepest) throw new Error("load button not found");
  return deepest as HTMLElement;
}

function addManualDatabase(root: HTMLElement, name: string) {
  const input = manualInput(root);
  input.value = name;
  input.dispatchEvent(new Event("input"));
  return nextTick().then(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    return nextTick();
  });
}

describe("McpDatabaseScopePicker", () => {
  it("加载资源列表前先 ensureConnected（不激活侧边栏），未连接的 SQL 连接不再直接调 listDatabases", async () => {
    mocks.listDatabases.mockResolvedValue([{ name: "ORCL" }]);
    const first = mountHarness([]);
    await nextTick();
    clickScopeRadio(first.root, "selected");
    await nextTick();
    first.app.unmount();
    harness = null;

    const second = mountHarness([emptyPolicy("oracle-1", "selected")]);
    await nextTick();
    loadButton(second.root).click();
    await new Promise((r) => setTimeout(r, 10));
    await nextTick();

    expect(mocks.ensureConnected).toHaveBeenCalledWith("oracle-1", { activate: false });
    // ensureConnected 成功后加载数据库列表
    expect(mocks.listDatabases).toHaveBeenCalledWith("oracle-1");
    expect(second.root.textContent).toContain("ORCL");
  });

  it("加载失败时 ensureConnected 的连接错误透传到错误提示", async () => {
    mocks.ensureConnected.mockRejectedValue(new Error("ORA-12170: 连接超时"));
    const first = mountHarness([]);
    await nextTick();
    clickScopeRadio(first.root, "selected");
    await nextTick();
    first.app.unmount();
    harness = null;

    const second = mountHarness([emptyPolicy("oracle-1", "selected")]);
    await nextTick();
    loadButton(second.root).click();
    await new Promise((r) => setTimeout(r, 10));
    await nextTick();

    expect(second.root.textContent).toContain("settings.mcpDatabaseLoadFailed");
    expect(second.root.textContent).toContain("ORA-12170");
    expect(mocks.listDatabases).not.toHaveBeenCalled();
  });

  it("正常流程：选择 selected 后手工添加库名应 emit 携带 allowedDatabases", async () => {
    // 阶段一：初始无策略，点击“仅指定数据库”
    const first = mountHarness([]);
    await nextTick();
    clickScopeRadio(first.root, "selected");
    await nextTick();
    expect(first.emitted.policies.length).toBe(1);
    expect(first.emitted.policies[0][0].databaseScope).toBe("selected");
    first.app.unmount();
    harness = null;

    // 阶段二：模拟父组件 store 已回写 scope=selected，再手工添加库名
    const second = mountHarness([emptyPolicy("oracle-1", "selected")]);
    await nextTick();
    await addManualDatabase(second.root, "mydb");

    expect(second.emitted.policies.length).toBe(1);
    const policy = second.emitted.policies[0][0];
    expect(policy.databaseScope).toBe("selected");
    expect(policy.allowedDatabases).toEqual(["mydb"]);
  });

  it("竞态场景：disabled 期间手工添加被整体拦截，库名不再进入本地列表", async () => {
    const { emitted, root } = mountHarness([emptyPolicy("oracle-1", "selected")], true);
    await nextTick();
    await addManualDatabase(root, "mydb");

    expect(emitted.policies.length).toBe(0);
    expect(root.textContent).not.toContain("mydb");
    // 手工输入框本身也应被禁用
    expect(manualInput(root).hasAttribute("disabled")).toBe(true);
  });

  it("重开对话框场景：已持久化的 allowedDatabases 重新显示在列表中并处于勾选状态", async () => {
    // 模拟：策略已保存 scope=selected + allowedDatabases=["SAVEDDB"]，加载缓存为空（新会话）
    const policy: McpConnectionPolicy = { ...emptyPolicy("oracle-1", "selected"), allowedDatabases: ["SAVEDDB"] };
    const { root } = mountHarness([policy]);
    await nextTick();

    expect(root.textContent).toContain("SAVEDDB");
    expect(root.textContent).not.toContain("settings.mcpDatabaseEmptyHint");
    const checkbox = Array.from(root.querySelectorAll('input[type="checkbox"]')).find((i) => i.value === "SAVEDDB" || i.closest("label")?.textContent?.includes("SAVEDDB"));
    expect(checkbox?.checked).toBe(true);
  });

  it("加载列表与已持久化库名取并集：手工添加过但服务器上不存在的库名仍可见", async () => {
    mocks.listDatabases.mockResolvedValue([{ name: "SERVER_DB" }]);
    const first = mountHarness([]);
    await nextTick();
    clickScopeRadio(first.root, "selected");
    await nextTick();
    first.app.unmount();
    harness = null;

    const second = mountHarness([{ ...emptyPolicy("oracle-1", "selected"), allowedDatabases: ["MANUAL_DB"] }]);
    await nextTick();
    loadButton(second.root).click();
    await new Promise((r) => setTimeout(r, 10));
    await nextTick();

    expect(second.root.textContent).toContain("SERVER_DB");
    expect(second.root.textContent).toContain("MANUAL_DB");
  });
});
