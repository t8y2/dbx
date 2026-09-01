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

  it("shows a progress ring while downloading, growing with progress", async () => {
    const state = reactive({ downloading: true, progress: 0.42 });
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(
      defineComponent({
        setup: () => () => h(ToolbarUpdateIcon, { loading: false, downloading: state.downloading, progress: state.progress }),
      }),
    );
    mountedApps.push(app);
    app.mount(container);
    await nextTick();

    const ring = container.querySelector<HTMLElement>("[data-toolbar-update-progress]");
    expect(ring).not.toBeNull();
    expect(ring?.classList.contains("toolbar-update-progress--indeterminate")).toBe(false);
    expect(ring?.style.background).toBe("conic-gradient(var(--primary) 42%, transparent 42%)");
    // The idle and checking glyphs stay hidden behind the ring.
    expect(container.querySelector("[data-toolbar-update-idle]")).toBeNull();
    expect(container.querySelector("[data-toolbar-update-cloud]")).toBeNull();

    state.progress = 1;
    await nextTick();
    expect(ring?.style.background).toBe("conic-gradient(var(--primary) 100%, transparent 100%)");

    state.downloading = false;
    await nextTick();
    expect(container.querySelector("[data-toolbar-update-progress]")).toBeNull();
    expect(container.querySelector("[data-toolbar-update-idle]")).not.toBeNull();
  });

  it("falls back to a rotating indeterminate arc when the download size is unknown", async () => {
    const state = reactive({ downloading: true, progress: null as number | null });
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(
      defineComponent({
        setup: () => () => h(ToolbarUpdateIcon, { loading: true, downloading: state.downloading, progress: state.progress }),
      }),
    );
    mountedApps.push(app);
    app.mount(container);
    await nextTick();

    const ring = container.querySelector<HTMLElement>("[data-toolbar-update-progress]");
    expect(ring).not.toBeNull();
    // Indeterminate downloading outranks the checking animation.
    expect(container.querySelector("[data-toolbar-update-cloud]")).toBeNull();
    expect(ring?.classList.contains("toolbar-update-progress--indeterminate")).toBe(true);
    expect(ring?.style.background).toBe("conic-gradient(var(--primary) 25%, transparent 25%)");
  });
});
