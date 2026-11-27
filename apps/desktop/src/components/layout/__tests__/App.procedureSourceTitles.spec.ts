// @vitest-environment happy-dom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App, type ComponentInternalInstance, type VNode } from "vue";
import DbxApp from "@/App.vue";
import i18n from "@/i18n";
import { tabDisplayTitle, tabTooltipLines } from "@/lib/tabs/tabPresentation";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";

const connection = { id: "test-kingbase", name: "Kingbase", db_type: "kingbase", database: "test-db", username: "test", host: "127.0.0.1", port: 54321, transport_layers: [] };
const schema = "public";
const name = "test_procedure";
let app: App | undefined;
let container: HTMLElement | undefined;

function findComponent(vnode: VNode | null, name: string): ComponentInternalInstance | undefined {
  const instance = vnode?.component;
  if (instance) {
    if (instance.type.name === name || ("__name" in instance.type && instance.type.__name === name)) return instance;
    return findComponent(instance.subTree, name);
  }
  for (const child of Array.isArray(vnode?.children) ? vnode.children : []) {
    if (typeof child !== "object" || child === null || !("component" in child)) continue;
    const found = findComponent(child, name);
    if (found) return found;
  }
}

afterEach(async () => {
  app?.unmount();
  app = undefined;
  await vi.dynamicImportSettled();
  container?.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("stored procedure source tab titles", () => {
  it.each(["editor object navigation", "Quick Open"])("shows, hides and restores signatures from %s", async (entry) => {
    vi.stubGlobal(
      "EventSource",
      class extends EventTarget {
        close = vi.fn();
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const { pathname, searchParams } = new URL(input, window.location.href);
        if (pathname === "/api/connection/list") return Response.json([connection]);
        if (pathname === "/api/connection/is-open") return Response.json(true);
        if (pathname === "/api/layout/sidebar") return Response.json(null);
        if (pathname === "/api/saved-sql") return Response.json({ files: [], folders: [] });
        if (pathname === "/api/version") return Response.json({ version: "0.0.0-test" });
        if (pathname === "/api/schema/object-source") return Response.json({ source: `CREATE PROCEDURE ${name}(${searchParams.get("signature")}) AS BEGIN NULL; END;`, editable: true });
        if (pathname === "/api/query/build-editable-object-source") return Response.json(JSON.parse(String(init?.body)).input.source);
        return Response.json([]);
      }),
    );
    const pinia = createPinia();
    setActivePinia(pinia);
    const connections = useConnectionStore();
    const settings = useSettingsStore();
    const query = useQueryStore();
    container = document.createElement("div");
    document.body.append(container);
    app = createApp(DbxApp, { startupAuthentication: { required: false, authenticated: true, setup_required: false } })
      .use(pinia)
      .use(i18n);
    app.mount(container);
    await vi.waitFor(() => expect(connections.treeNodes.some((node) => node.id === connection.id)).toBe(true), { timeout: 5000 });
    settings.editorSettings.routineSourceOpenMode = "query-tab";
    connections.connectedIds.add(connection.id);
    const origin = query.createTab(connection.id, connection.database, "Origin", "query", schema);
    await nextTick();

    const fromEditor = entry === "editor object navigation";
    const componentName = fromEditor ? "SqlEditorWorkspace" : "QuickOpenDialog";
    const findEntry = () => findComponent(app?._instance?.subTree ?? null, componentName);
    await vi.waitFor(() => expect(findEntry()).toBeDefined(), { timeout: 5000 });
    const sourceEntry = findEntry()!;
    const signatures = ["region integer", "region varchar"];
    for (const signature of signatures) {
      if (fromEditor) {
        sourceEntry.emit("openObjectSource", origin, { name, type: "procedure", schema, signature }, true);
      } else {
        sourceEntry.emit("select", { objectName: name, type: "procedure", connectionId: connection.id, database: connection.database, schema, signature });
      }
      await vi.waitFor(() => expect(query.tabs.some((tab) => tab.objectSource?.signature === signature && !tab.sourceLoad)).toBe(true), { timeout: 5000 });
    }

    const sourceTabs = query.tabs.filter((tab) => tab.objectSource?.name === name);
    const title = `Source - ${name}`;
    const translate = (key: string) => key;
    const displayed = () => sourceTabs.map((tab) => tabDisplayTitle(tab, translate));
    const fullTitles = signatures.map((signature) => `${title}(${signature})`);
    expect(displayed()).toEqual(fullTitles);
    settings.editorSettings.hideProcedureTabSignatures = true;
    expect(displayed()).toEqual([title, title]);
    expect(sourceTabs.map((tab) => tabTooltipLines(tab, translate).find((line) => line.label === "tabs.tooltipTitle")?.value)).toEqual(fullTitles);
    settings.editorSettings.hideProcedureTabSignatures = false;
    expect(displayed()).toEqual(fullTitles);
  });
});
