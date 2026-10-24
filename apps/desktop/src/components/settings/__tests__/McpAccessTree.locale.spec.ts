// @vitest-environment happy-dom

import { createApp, h, nextTick, ref } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import McpAccessTree from "../McpAccessTree.vue";
import en from "@/i18n/locales/en";
import zhCN from "@/i18n/locales/zh-CN";
import type { ConnectionConfig } from "@/types/database";
import type { McpAccessPolicy } from "@/types/mcpCatalog";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((unmount) => unmount()));

describe("McpAccessTree translated selections", () => {
  it("renders native mixed checkboxes, reacts to descendant changes, and selects the whole group on click", async () => {
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { en, "zh-CN": zhCN } as Record<string, Record<string, unknown>> });
    const policy = ref({ readOnly: true, allowDangerousSql: false, allowedConnectionIds: ["c1"] as string[] | null, allowedGroupIds: [] as string[], connectionPolicies: [], groupPolicies: [] });
    const groupChange = vi.fn((id: string, visible: boolean) => {
      policy.value = { ...policy.value, allowedConnectionIds: [], allowedGroupIds: visible ? [id] : [] };
    });
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp({
      render: () =>
        h(McpAccessTree, {
          policy: policy.value,
          connections: ["c1", "c2"].map((id) => ({ id, name: id, db_type: "mysql" }) as ConnectionConfig),
          layout: {
            groups: [
              { id: "parent", name: "Parent", collapsed: true },
              { id: "child", name: "Child", collapsed: true },
            ],
            order: [
              {
                type: "group",
                id: "parent",
                children: [
                  { type: "group", id: "child", children: [{ type: "connection", id: "c1" }] },
                  { type: "connection", id: "c2" },
                ],
              },
            ],
          },
          "onSet:group-visible": groupChange,
        }),
    }).use(i18n);
    app.mount(root);
    cleanup.push(() => {
      app.unmount();
      root.remove();
    });
    await nextTick();
    const checkbox = () => root.querySelector<HTMLInputElement>('[data-mcp-access-visible="group:parent"]')!;
    const effective = () => root.querySelector('[data-mcp-access-effective="group:parent"]')!.textContent;
    expect(checkbox().indeterminate).toBe(true);
    expect(checkbox().getAttribute("aria-checked")).toBe("mixed");
    expect(effective()).toContain("部分连接可见（1/2）");
    policy.value = { ...policy.value, allowedConnectionIds: ["c1", "c2"] };
    await nextTick();
    expect(checkbox().indeterminate).toBe(true);
    expect(effective()).toContain("当前连接均可见（2/2）");
    i18n.global.locale.value = "en";
    await nextTick();
    expect(effective()).toContain("All current connections visible (2/2)");
    expect(checkbox().title).toBe(en.settings.mcpAccessTreeGroupChildrenOnlyHint);
    checkbox().click();
    await nextTick();
    expect(groupChange).toHaveBeenCalledExactlyOnceWith("parent", true);
    expect(checkbox().checked).toBe(true);
    expect(checkbox().indeterminate).toBe(false);
    root.querySelector<HTMLButtonElement>('[data-mcp-access-group-name="parent"]')!.click();
    await nextTick();
    const child = root.querySelector<HTMLInputElement>('[data-mcp-access-visible="group:child"]')!;
    expect(child.checked).toBe(true);
    expect(child.indeterminate).toBe(false);
    expect(child.disabled).toBe(true);
    checkbox().click();
    await nextTick();
    expect(checkbox().checked).toBe(false);
    expect(checkbox().indeterminate).toBe(false);
    expect(effective()).toContain(en.settings.mcpAccessTreeHidden);
    policy.value = { ...policy.value, allowedConnectionIds: null };
    await nextTick();
    expect(checkbox().checked).toBe(true);
    expect(checkbox().indeterminate).toBe(false);
    expect(checkbox().disabled).toBe(true);
  });

  it.each(["nacos", "plugin"])("updates %s sub-scope counts and selected labels without reopening the controls", async (provider) => {
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { en, "zh-CN": zhCN } as Record<string, Record<string, unknown>> });
    const access = ref<McpAccessPolicy>({
      version: 2,
      defaultAccess: "write",
      rules: [
        { target: { kind: "connection", id: "scoped" }, subScope: "selected" },
        { target: { kind: "scope", connectionId: "scoped", scope: "namespace", value: "team" }, visible: true, access: "read" },
      ],
    });
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp({
      render: () =>
        h(McpAccessTree, {
          policy: { readOnly: true, allowDangerousSql: false, allowedConnectionIds: null, allowedGroupIds: [], connectionPolicies: [], groupPolicies: [] },
          layout: { groups: [], order: [{ type: "connection", id: "scoped" }] },
          connections: [{ id: "scoped", name: "Scoped", db_type: provider === "nacos" ? "nacos" : "mysql", ...(provider === "plugin" ? { plugin_id: "demo" } : {}) } as ConnectionConfig],
          pluginScopes: { demo: { kind: "namespace", title: "Namespace" } },
          accessPolicy: access.value,
          savePluginScope: vi.fn(async () => access.value),
        }),
    }).use(i18n);
    app.mount(root);
    cleanup.push(() => {
      app.unmount();
      root.remove();
    });
    await nextTick();
    await nextTick();
    const mode = root.querySelector('[data-mcp-plugin-scope-mode="scoped"]')!;
    const level = root.querySelector('[data-mcp-plugin-scope-value="team"] [role="combobox"]')!;
    expect(mode.textContent).toContain("指定（1）");
    access.value = { ...access.value, rules: [...access.value.rules, { target: { kind: "scope", connectionId: "scoped", scope: "namespace", value: "ops" }, visible: true }] };
    await nextTick();
    await nextTick();
    expect(mode.textContent).toContain("指定（2）");
    i18n.global.locale.value = "en";
    await nextTick();
    await nextTick();
    expect(mode.textContent).toContain("Selected (2)");
    expect(level.textContent).toContain(en.settings.mcpExecutionModeReadOnly);
    expect(level.textContent).not.toContain(zhCN.settings.mcpExecutionModeReadOnly);
  });

  it("updates selected permission and database scope labels when the language changes", async () => {
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { en, "zh-CN": zhCN } as Record<string, Record<string, unknown>> });
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp({
      render: () =>
        h(McpAccessTree, {
          policy: { readOnly: true, allowDangerousSql: false, allowedConnectionIds: null, allowedGroupIds: [], connectionPolicies: [], groupPolicies: [] },
          layout: { groups: [], order: [{ type: "connection", id: "dev" }] },
          connections: [{ id: "dev", name: "Development", db_type: "mysql" } as ConnectionConfig],
        }),
    }).use(i18n);
    app.mount(root);
    cleanup.push(() => {
      app.unmount();
      root.remove();
    });
    await nextTick();
    await nextTick();
    const permission = root.querySelector('[data-mcp-access-setting="connection:dev"]')!;
    const scope = root.querySelector('[data-mcp-access-database-scope="dev"]')!;
    expect(permission.textContent).toContain(zhCN.settings.mcpAccessTreeInherit);
    expect(scope.textContent).toContain(zhCN.settings.mcpAccessTreeDatabaseScopeAll);
    i18n.global.locale.value = "en";
    await nextTick();
    await nextTick();
    expect(permission.textContent).toContain(en.settings.mcpAccessTreeInherit);
    expect(scope.textContent).toContain(en.settings.mcpAccessTreeDatabaseScopeAll);
    expect(permission.textContent).not.toContain(zhCN.settings.mcpAccessTreeInherit);
  });
});
