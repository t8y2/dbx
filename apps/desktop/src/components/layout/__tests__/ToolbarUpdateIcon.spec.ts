// @vitest-environment happy-dom
import { createApp, h } from "vue";
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
});
