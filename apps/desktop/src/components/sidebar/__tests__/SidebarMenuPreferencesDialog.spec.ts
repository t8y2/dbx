// @vitest-environment happy-dom
import { createApp, h, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SidebarMenuPreferencesDialog from "../SidebarMenuPreferencesDialog.vue";
import { DEFAULT_EDITOR_SETTINGS, useSettingsStore } from "@/stores/settingsStore";
import type { ContextMenuItem } from "@/components/ui/customContextMenuRegistry";

const backend = vi.hoisted(() => ({ loadEditorSettings: vi.fn(), saveEditorSettings: vi.fn() }));
vi.mock("@/lib/backend/api", () => backend);
const apps: App[] = [];
const entry = (id: string, label: string, extras: Partial<ContextMenuItem> = {}): ContextMenuItem => ({ sidebarActionId: id, label, action: vi.fn(), ...extras });
const items = [
  entry("contextMenu.newQuery", "New query"),
  entry("contextMenu.refreshChildren", "Refresh"),
  entry("contextMenu.serverDashboard", "Dashboard"),
  entry("contextMenu.processList", "Processes"),
  entry("contextMenu.sqlServerTrace", "Trace"),
  entry("contextMenu.copyName", "Copy name"),
  entry("contextMenu.exportData", "Export", { children: [{ label: "CSV", action: vi.fn() }] }),
  entry("contextMenu.deleteConnection", "Delete", { variant: "destructive" }),
];

async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}
function button(name: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.getAttribute("aria-label") === name || el.textContent?.trim() === name);
  expect(result, name).toBeDefined();
  return result!;
}
function row(id: string) {
  return document.querySelector<HTMLElement>(`[data-menu-entry="${id}"]`)!;
}
function checkbox(name: string) {
  const result = [...document.querySelectorAll("label")].find((el) => el.textContent?.includes(name))?.querySelector<HTMLInputElement>("input");
  expect(result, name).toBeDefined();
  return result!;
}
function visibleOrder() {
  return [...document.querySelectorAll<HTMLElement>("[data-menu-entry]")].map((el) => el.dataset.menuEntry);
}

async function mount() {
  const pinia = createPinia();
  const settings = useSettingsStore(pinia);
  await settings.initEditorSettings();
  const close = vi.fn();
  const app = createApp({ render: () => h(SidebarMenuPreferencesDialog, { open: true, scope: "connection", items, "onUpdate:open": close }) });
  app.use(pinia);
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      missingWarn: false,
      fallbackWarn: false,
      messages: { en: { sidebarMenu: { moveUp: "Move up {name}", moveDown: "Move down {name}", dragAction: "Reorder {name}", groups: { copy: "Copy", data: "Data", connectionTools: "Database tools", danger: "Danger" } } } },
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  apps.push(app);
  await flush();
  return { settings, close };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  backend.loadEditorSettings.mockResolvedValue(DEFAULT_EDITOR_SETTINGS);
  backend.saveEditorSettings.mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount();
  await flush();
  document.body.innerHTML = "";
});

describe("sidebar menu customization", () => {
  it("offers only grouped-menu customization and does not mutate the global layout", async () => {
    backend.loadEditorSettings.mockResolvedValue({ ...DEFAULT_EDITOR_SETTINGS, sidebarMenuLayout: "full" });
    const { settings } = await mount();
    expect(document.querySelector("h2")?.textContent).toBe("sidebarMenu.customizeTitle");
    expect(document.body.textContent).toContain("sidebarMenu.scopedDescription");
    expect(document.body.textContent).not.toContain("sidebarMenu.full");
    expect(document.body.textContent).not.toContain("sidebarMenu.groupedOnly");
    button("common.save").click();
    await flush();
    expect(settings.editorSettings.sidebarMenuLayout).toBe("full");
    expect(backend.saveEditorSettings.mock.calls[0][0].sidebarMenuLayout).toBe("full");
  });
  it("permits cancelling recommended defaults and saves their exclusion", async () => {
    const { settings, close } = await mount();
    expect(checkbox("Dashboard").checked).toBe(true);
    expect(checkbox("Dashboard").disabled).toBe(false);
    expect(checkbox("New query").disabled).toBe(true);
    checkbox("Dashboard").click();
    await flush();
    expect(checkbox("Dashboard").checked).toBe(false);
    button("common.save").click();
    await flush();
    expect(settings.editorSettings.sidebarMenuHiddenPrimaryActions.connection).toEqual(["contextMenu.serverDashboard"]);
    expect(close).toHaveBeenCalledWith(false);
  });

  it("saves a changed primary order from arrow buttons", async () => {
    const { settings } = await mount();
    const original = visibleOrder();
    button("Move up Dashboard").click();
    await flush();
    expect(visibleOrder().indexOf("contextMenu.serverDashboard")).toBe(original.indexOf("contextMenu.serverDashboard") - 1);
    button("common.save").click();
    await flush();
    expect(settings.editorSettings.sidebarMenuOrder.connection?.slice(0, 3)).toEqual(["contextMenu.newQuery", "contextMenu.serverDashboard", "contextMenu.refreshChildren"]);
  });

  it("reorders a dragged entry and keeps group order separate", async () => {
    const { settings } = await mount();
    button("Reorder Trace").dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    row("contextMenu.newQuery").dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    row("contextMenu.newQuery").dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await flush();
    expect(visibleOrder()[0]).toBe("contextMenu.sqlServerTrace");
    button("sidebarMenu.groupOrder").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    await flush();
    expect(visibleOrder()).toEqual(["group.copy", "group.manage"]);
    button("Move up Database tools").click();
    await flush();
    expect(visibleOrder()).toEqual(["group.manage", "group.copy"]);
    button("common.save").click();
    await flush();
    expect(settings.editorSettings.sidebarMenuOrder.connection?.[0]).toBe("contextMenu.sqlServerTrace");
    expect(settings.editorSettings.sidebarMenuOrder.connection?.slice(-2)).toEqual(["group.manage", "group.copy"]);
  });

  it("resets recommendations and order without committing a cancelled draft", async () => {
    const { settings, close } = await mount();
    checkbox("Dashboard").click();
    button("Move up Trace").click();
    await flush();
    button("sidebarMenu.reset").click();
    await flush();
    expect(checkbox("Dashboard").checked).toBe(true);
    expect(visibleOrder()[0]).toBe("contextMenu.newQuery");
    checkbox("Dashboard").click();
    await flush();
    button("common.cancel").click();
    await flush();
    expect(settings.editorSettings.sidebarMenuHiddenPrimaryActions).toEqual({});
    expect(settings.editorSettings.sidebarMenuOrder).toEqual({});
    expect(backend.saveEditorSettings).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(false);
  });
});
