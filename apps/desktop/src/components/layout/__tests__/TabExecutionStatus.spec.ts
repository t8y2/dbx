// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import TabExecutionStatus from "../TabExecutionStatus.vue";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const mountedApps: ReturnType<typeof createApp>[] = [];

function mountStatus(initial: { mode: "query" | "data"; isExecuting: boolean; isCancelling?: boolean; sourceLoad?: { startedAt: number; error?: string; request: { name: string; objectType: string } } }, withFallback = false) {
  const state = reactive(initial);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const app = createApp({
    setup: () => () => h(TabExecutionStatus, { tab: state }, withFallback ? { default: () => h("span", { "data-tab-icon": "" }) } : undefined),
  });
  mountedApps.push(app);
  app.mount(root);
  return { root, state };
}

describe("TabExecutionStatus", () => {
  afterEach(() => {
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
  });

  it("shows an accessible, reduced-motion-safe running indicator", async () => {
    const { root } = mountStatus({ mode: "query", isExecuting: true, isCancelling: false });
    await nextTick();

    const status = root.querySelector<HTMLElement>("[data-tab-execution-status]");
    expect(status?.getAttribute("aria-label")).toBe("common.loading");
    expect(status?.className).toContain("text-blue-600");
    expect(status?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(status?.querySelector("svg")?.getAttribute("class")).toContain("motion-reduce:animate-none");
  });

  it("announces cancelling distinctly", async () => {
    const { root } = mountStatus({ mode: "query", isExecuting: true, isCancelling: true });
    await nextTick();

    const status = root.querySelector<HTMLElement>("[data-tab-execution-status]");
    expect(status?.getAttribute("aria-label")).toBe("common.stopping");
    expect(status?.className).toContain("text-amber-600");
  });

  it("replaces the tab icon while the query is executing", async () => {
    const { root, state } = mountStatus({ mode: "query", isExecuting: false }, true);
    await nextTick();
    expect(root.querySelector("[data-tab-icon]")).not.toBeNull();

    state.isExecuting = true;
    await nextTick();
    expect(root.querySelector("[data-tab-icon]")).toBeNull();
    expect(root.querySelector("[data-tab-execution-status]")).not.toBeNull();

    state.isExecuting = false;
    await nextTick();
    expect(root.querySelector("[data-tab-execution-status]")).toBeNull();
    expect(root.querySelector("[data-tab-icon]")).not.toBeNull();
  });

  it.each(["success", "error", "cancelled"])("disappears as soon as %s completes", async () => {
    const { root, state } = mountStatus({ mode: "query", isExecuting: true, isCancelling: true });
    await nextTick();
    state.isExecuting = false;
    state.isCancelling = false;
    await nextTick();

    expect(root.querySelector("[data-tab-execution-status]")).toBeNull();
  });

  it("does not show query status for idle or non-query tabs", async () => {
    const idle = mountStatus({ mode: "query", isExecuting: false });
    const data = mountStatus({ mode: "data", isExecuting: true });
    await nextTick();

    expect(idle.root.querySelector("[data-tab-execution-status]")).toBeNull();
    expect(data.root.querySelector("[data-tab-execution-status]")).toBeNull();
  });

  // issue #9035：源码 tab 先出现再加载，加载中的等待必须有反馈。
  it("shows the loading indicator while an object source tab is still loading", async () => {
    const { root, state } = mountStatus({ mode: "query", isExecuting: false, sourceLoad: { startedAt: Date.now(), request: { name: "v_orders", objectType: "VIEW" } } }, true);
    await nextTick();

    const status = root.querySelector<HTMLElement>("[data-tab-execution-status]");
    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-label")).toBe("common.loading");
    expect(status?.className).toContain("text-blue-600");
    // 加载态占用图标位，与查询执行中的表现一致
    expect(root.querySelector("[data-tab-icon]")).toBeNull();

    state.sourceLoad = undefined;
    await nextTick();
    expect(root.querySelector("[data-tab-execution-status]")).toBeNull();
    expect(root.querySelector("[data-tab-icon]")).not.toBeNull();
  });

  it("stops the loading indicator once the object source load failed", async () => {
    const { root } = mountStatus({ mode: "query", isExecuting: false, sourceLoad: { startedAt: Date.now(), error: "ORA-00942", request: { name: "v_orders", objectType: "VIEW" } } }, true);
    await nextTick();

    // 失败态由 tab 内容区的错误 + Retry 表达，tab 栏不应继续转圈
    expect(root.querySelector("[data-tab-execution-status]")).toBeNull();
    expect(root.querySelector("[data-tab-icon]")).not.toBeNull();
  });
});
