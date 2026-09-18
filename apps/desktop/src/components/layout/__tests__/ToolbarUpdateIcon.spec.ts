// @vitest-environment happy-dom
import { createApp, h } from "vue";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ToolbarUpdateIcon from "../ToolbarUpdateIcon.vue";
describe("silent toolbar update icon", () => {
  it.each([{ loading: false }, { loading: true }, { downloading: true, progress: 0.4 }, { downloading: true, progress: null }])("keeps the ordinary icon for %o", (props) => {
    const container = document.createElement("div");
    const app = createApp({ render: () => h(ToolbarUpdateIcon, props) });
    app.mount(container);
    expect(container.querySelector("[data-toolbar-update-idle]")).not.toBeNull();
    expect(container.querySelector("[data-toolbar-update-progress], [data-toolbar-update-scan]")).toBeNull();
    app.unmount();
  });

  it("renders a text Update action whenever any aggregate update is available", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/layout/AppToolbar.vue"), "utf8");

    expect(source).toContain('v-if="hasUpdateAvailable"');
    expect(source).toContain("data-toolbar-update-action");
    expect(source).toContain('t("updates.updateAction")');
  });

  it("passes only opt-out component badges to their separate toolbar entries", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/App.vue"), "utf8");

    expect(source).toContain(':agent-driver-update-count="showDriverStoreUpdateBadge"');
    expect(source).toContain(':has-mcp-update-available="showMcpSettingsUpdateBadge"');
    expect(source).not.toContain(':agent-driver-update-count="toolbarDriverUpdateCount"');
  });
});
