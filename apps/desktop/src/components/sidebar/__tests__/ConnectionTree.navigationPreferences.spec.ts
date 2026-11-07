// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { parse } from "vue/compiler-sfc";
import { createApp, h, type App } from "vue";
import { createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSidebarMenuPresentation } from "@/composables/useSidebarMenuPresentation";
import type { TreeNode } from "@/types/database";
import { sidebarMenuEn } from "@/i18n/locales/sidebarMenuMessages";

const source = parse(readFileSync(resolve("apps/desktop/src/components/sidebar/ConnectionTree.vue"), "utf8")).descriptor.scriptSetup!.content;
const script = ts.createSourceFile("ConnectionTree.ts", source, ts.ScriptTarget.Latest, true);
const apps: App[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});
function fixture() {
  let menu!: ReturnType<typeof useSidebarMenuPresentation>;
  const app = createApp({
    setup() {
      menu = useSidebarMenuPresentation();
      return () => h("div");
    },
  });
  app.use(createPinia());
  app.use(createI18n({ legacy: false, locale: "en", missingWarn: false, messages: { en: { sidebarMenu: sidebarMenuEn } } }));
  const host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  apps.push(app);
  const store = { getConfig: vi.fn(() => ({ database: "configured" })), treeNodes: [] as TreeNode[], ensureConnected: vi.fn(), startEditing: vi.fn() };
  const sidebarTreeRuntime = { buildContextMenu: vi.fn(() => [{ label: "Query", action: vi.fn() }]), resolveContextMenu: vi.fn() };
  const bindings = { store, sidebarTreeRuntime, beginSidebarAction: vi.fn() };
  const functions = ["openSidebarVisibleDatabases", "openSidebarVisibleSchemas"].map((name) => script.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name)!.getText(script)).join("\n");
  const compiled = ts.transpileModule(`${functions}\nreturn {openSidebarVisibleDatabases, openSidebarVisibleSchemas};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const actions = new Function(...Object.keys(bindings), compiled)(...Object.values(bindings)) as { openSidebarVisibleDatabases: (node: TreeNode) => void; openSidebarVisibleSchemas: (node: TreeNode) => void };
  return { menu, store, sidebarTreeRuntime, ...actions };
}
describe("navigation preference shortcuts", () => {
  it.each(["connection", "database"] as const)("opens schema visibility from a %s in connection editing with the correct filter context", (type) => {
    const { menu, store, sidebarTreeRuntime, openSidebarVisibleSchemas } = fixture();
    openSidebarVisibleSchemas({ id: "target", type, label: "App", connectionId: "A", database: type === "database" ? "actual" : undefined, schema: "selected" });
    expect(menu.sidebarMenuPreferencesOpen.value).toBe(false);
    expect(store.startEditing).toHaveBeenCalledWith("A", type === "database" ? { visibleSchemaDatabase: "actual" } : undefined);
    expect(store.ensureConnected).not.toHaveBeenCalled();
    expect(sidebarTreeRuntime.resolveContextMenu).not.toHaveBeenCalled();
  });
  it("opens database visibility in connection editing without opening menu preferences", () => {
    const { menu, store, openSidebarVisibleDatabases } = fixture();
    openSidebarVisibleDatabases({ id: "A", type: "connection", label: "A", connectionId: "A" });
    expect(menu.sidebarMenuPreferencesOpen.value).toBe(false);
    expect(store.startEditing).toHaveBeenCalledWith("A");
    expect(store.ensureConnected).not.toHaveBeenCalled();
  });
  it("opens ordinary menu customization with menu-only labeling", () => {
    const { menu } = fixture();
    const customize = menu.presentMenu([], "database").find((item) => item.label === sidebarMenuEn.customize)!;
    customize.action!();
    expect(menu.sidebarMenuPreferences.value).toMatchObject({ scope: "database" });
  });
});
