// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it } from "vitest";
import QueryResultViewSwitcher from "@/components/layout/QueryResultViewSwitcher.vue";
import type { RedisResultViewMode, TabOutputView } from "@/types/database";

const mounted: Array<{ unmount: () => void; host: HTMLElement }> = [];

afterEach(() => {
  for (const { unmount, host } of mounted.splice(0)) {
    unmount();
    host.remove();
  }
});

async function mountSwitcher(canShowRedisConsole: boolean, canShowGraph = false) {
  const state = reactive<{ view: TabOutputView; mode?: RedisResultViewMode }>({ view: "result" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(QueryResultViewSwitcher, {
          activeView: state.view,
          canShowResult: true,
          canShowSummary: false,
          canShowChart: false,
          canShowMessages: false,
          canShowRedisConsole,
          canShowGraph,
          resultMode: state.mode,
          onSelectView: (view: TabOutputView) => {
            state.view = view;
          },
          onSelectResultMode: (mode: RedisResultViewMode) => {
            state.mode = mode;
          },
        }),
    }),
  );
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: { en: { tabs: { tableData: "Table Data", executionSummary: "Summary", messages: "Messages" }, chart: { title: "Chart" }, graph: { title: "Graph" }, redis: { commandLine: "Command line" } } },
    }),
  );
  app.mount(host);
  mounted.push({ unmount: () => app.unmount(), host });
  await nextTick();
  return { host, state };
}

describe("QueryResultViewSwitcher Redis mode", () => {
  it("defaults Redis results to the grid and switches through the existing toolbar contract", async () => {
    const { host, state } = await mountSwitcher(true);
    const grid = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Table Data"));
    const console = host.querySelector<HTMLButtonElement>('button[aria-label="Command line"]');

    expect(state.mode).toBeUndefined();
    expect(grid?.getAttribute("aria-pressed")).toBe("true");
    expect(console?.getAttribute("aria-pressed")).toBe("false");

    console?.click();
    await nextTick();

    expect(state.mode).toBe("console");
    expect(state.view).toBe("result");
    expect(console?.getAttribute("aria-pressed")).toBe("true");

    grid?.click();
    await nextTick();
    expect(state.mode).toBe("grid");
    expect(grid?.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not expose the Redis-only mode on generic result toolbars", async () => {
    const { host } = await mountSwitcher(false);
    expect(host.querySelector('button[aria-label="Command line"]')).toBeNull();
  });

  it("shows the graph view only for graph results and switches back to the table", async () => {
    const { host, state } = await mountSwitcher(false, true);
    const graph = host.querySelector<HTMLButtonElement>('button[aria-label="Graph"]');
    expect(graph).not.toBeNull();
    graph?.click();
    await nextTick();
    expect(state.view).toBe("graph");
    expect(graph?.getAttribute("aria-pressed")).toBe("true");
    host.querySelector<HTMLButtonElement>("button")?.click();
    await nextTick();
    expect(state.view).toBe("result");
  });
});
