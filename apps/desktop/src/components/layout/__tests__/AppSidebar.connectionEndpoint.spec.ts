// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getAllWebviewWindows: vi.fn(async () => []),
  WebviewWindow: { getByLabel: vi.fn(async () => null) },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    isMaximized: async () => false,
    isFullscreen: async () => false,
    isAlwaysOnTop: async () => false,
    setAlwaysOnTop: async () => {},
    onResized: async () => () => {},
    onFocusChanged: async () => () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
  }),
}));

vi.mock("@/components/sidebar/ConnectionTree.vue", () => ({
  default: { name: "ConnectionTreeStub", template: `<div />` },
}));
vi.mock("@/components/plugins/PluginShortcutBar.vue", () => ({
  default: { name: "PluginShortcutBarStub", template: `<div />` },
}));
vi.mock("@/components/ui/LightDropdown.vue", () => ({
  default: { name: "LightDropdownStub", template: `<div />` },
}));
vi.mock("@/components/ui/LightTooltip.vue", () => ({
  default: { name: "LightTooltipStub", props: ["text"], template: `<span :title="text"><slot /></span>` },
}));
vi.mock("@/components/ui/button", () => ({
  Button: { name: "ButtonStub", template: `<button><slot /></button>` },
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: { name: "DialogStub", template: `<div><slot /></div>` },
  DialogContent: { name: "DialogContentStub", template: `<div><slot /></div>` },
  DialogFooter: { name: "DialogFooterStub", template: `<div><slot /></div>` },
  DialogHeader: { name: "DialogHeaderStub", template: `<div><slot /></div>` },
  DialogTitle: { name: "DialogTitleStub", template: `<div><slot /></div>` },
}));
vi.mock("@/components/ui/input", () => ({
  Input: { name: "InputStub", template: `<input />` },
}));

import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import AppSidebar from "../AppSidebar.vue";

const connection = (id: string, host: string, port: number) =>
  ({
    id,
    name: `Connection ${id}`,
    db_type: "mysql",
    host,
    port,
    username: "root",
    password: "",
    database: "app",
  }) as never;

let pinia: ReturnType<typeof createPinia>;
let host: HTMLDivElement | null = null;

function mountSidebar() {
  host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(AppSidebar, { sidebarWidth: 260 });
  app.use(pinia);
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      missingWarn: false,
      fallbackWarn: false,
      messages: { en: {} },
    }),
  );
  app.mount(host);
  return app;
}

function endpointText(): string {
  return document.querySelector("[data-sidebar-connection-endpoint]")?.textContent?.trim() ?? "";
}

beforeEach(() => {
  pinia = createPinia();
});

afterEach(() => {
  host?.remove();
  host = null;
});

describe("AppSidebar current connection endpoint", () => {
  it("shows the active tab connection host and port", async () => {
    const connectionStore = useConnectionStore(pinia);
    const queryStore = useQueryStore(pinia);
    connectionStore.connections = [connection("c1", "10.0.0.5", 3306), connection("c2", "10.0.0.6", 5432)];
    connectionStore.activeConnectionId = "c2";
    queryStore.tabs = [{ id: "t1", connectionId: "c1" } as never];
    queryStore.activeTabId = "t1";

    mountSidebar();
    await nextTick();

    expect(endpointText()).toBe("10.0.0.5:3306");
  });

  it("falls back to the selected connection when no tab is open", async () => {
    const connectionStore = useConnectionStore(pinia);
    const queryStore = useQueryStore(pinia);
    connectionStore.connections = [connection("c1", "db.internal", 15432)];
    connectionStore.activeConnectionId = "c1";
    queryStore.tabs = [];
    queryStore.activeTabId = null;

    mountSidebar();
    await nextTick();

    expect(endpointText()).toBe("db.internal:15432");
  });

  it("renders nothing when no connection is active", async () => {
    const connectionStore = useConnectionStore(pinia);
    const queryStore = useQueryStore(pinia);
    connectionStore.connections = [];
    connectionStore.activeConnectionId = null;
    queryStore.tabs = [];
    queryStore.activeTabId = null;

    mountSidebar();
    await nextTick();

    expect(document.querySelector("[data-sidebar-connection-endpoint]")).toBeNull();
  });
});
