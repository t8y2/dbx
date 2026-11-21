// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "vue";
import { createI18n } from "vue-i18n";
import WelcomeScreen from "./WelcomeScreen.vue";

const runtime = vi.hoisted(() => ({ desktop: true }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => runtime.desktop }));
vi.mock("@/components/ui/TruncatedTextTooltip.vue", () => ({ default: { template: "<span><slot /></span>" } }));
vi.mock("@/components/ui/LightDropdown.vue", () => ({ default: { template: "<div />" } }));

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  document.body.innerHTML = "";
});

describe("welcome import shortcut", () => {
  it.each([true, false])("opens the appropriate import flow with desktop=%s", (desktop) => {
    runtime.desktop = desktop;
    const onImportConfig = vi.fn();
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(WelcomeScreen, {
      connectionStats: { total: 0, connected: 0, types: 0 },
      recentConnections: [],
      savedSqlHistoryItems: [],
      welcomePageMode: "workspace",
      appVersion: "test",
      canNewQuery: true,
      onImportConfig,
    });
    app.use(createI18n({ legacy: false, locale: "en", missingWarn: false, fallbackWarn: false, messages: { en: {} } }));
    app.mount(root);
    unmount = () => app.unmount();
    const button = [...root.querySelectorAll("button")].find((button) => button.textContent?.includes("sidebar.import"));
    expect(button).toBeDefined();
    button!.click();
    expect(onImportConfig).toHaveBeenCalledWith(desktop ? "installed" : "dbx");
  });
});
