// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import ToolbarUpdateIcon from "../ToolbarUpdateIcon.vue";

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("ToolbarUpdateIcon", () => {
  it("uses cloud download while idle and a cloud outline scan while checking", async () => {
    const state = reactive({ loading: false });
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(
      defineComponent({
        setup: () => () => h(ToolbarUpdateIcon, { loading: state.loading }),
      }),
    );
    mountedApps.push(app);
    app.mount(container);
    await nextTick();

    expect(container.querySelector("[data-toolbar-update-idle]")).not.toBeNull();
    expect(container.querySelector("[data-toolbar-update-cloud]")).toBeNull();

    state.loading = true;
    await nextTick();
    expect(container.querySelector("[data-toolbar-update-idle]")).toBeNull();
    expect(container.querySelector("[data-toolbar-update-cloud]")).not.toBeNull();
    expect(container.querySelector("[data-toolbar-update-scan]")).not.toBeNull();
  });
});
