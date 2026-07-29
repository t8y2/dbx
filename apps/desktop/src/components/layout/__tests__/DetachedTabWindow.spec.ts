// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DetachedTabWindow from "@/components/layout/DetachedTabWindow.vue";
import type { QueryTab } from "@/types/database";

vi.mock("@/components/layout/EditorToolbar.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      emits: ["execute", "formatSql"],
      setup(_, { emit }) {
        return () => h("div", [h("button", { "data-testid": "toolbar-execute", onClick: () => emit("execute") }), h("button", { "data-testid": "toolbar-format", onClick: () => emit("formatSql") })]);
      },
    }),
  };
});

vi.mock("@/components/layout/ContentArea.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      emits: ["execute", "reload"],
      setup(_, { emit, expose }) {
        expose({
          requestQueryEditorExecute: () => {
            emit("execute", "SELECT 1");
            return true;
          },
        });
        return () => h("div", [h("button", { "data-testid": "content-execute", onClick: () => emit("execute", "SELECT 2") }), h("button", { "data-testid": "content-reload", onClick: () => emit("reload", "SELECT 3") })]);
      },
    }),
  };
});

const mountedApps: App[] = [];

function queryTab(): QueryTab {
  return {
    id: "detached-query",
    connectionId: "connection-1",
    database: "db",
    title: "Query",
    mode: "query",
    sql: "SELECT 1",
  } as QueryTab;
}

async function mountDetachedWindow(listeners: Record<string, (...args: unknown[]) => void>) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(DetachedTabWindow, {
          activeTab: queryTab(),
          executableSql: "SELECT 1",
          activeOutputView: "result",
          formatSqlRequest: null,
          compressSqlRequest: null,
          selectedSql: "",
          cursorPos: 0,
          blockDangerousRedisCommands: true,
          explainMode: "explain",
          sqlKeywordCase: "preserve",
          autoCommit: true,
          ...listeners,
        }),
    }),
  );
  app.use(i18n);
  app.use(createPinia());
  app.mount(container);
  mountedApps.push(app);
  await nextTick();
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("DetachedTabWindow event forwarding", () => {
  it("forwards content and toolbar actions to the owning App", async () => {
    const onExecute = vi.fn();
    const onReload = vi.fn();
    const onFormatSql = vi.fn();
    await mountDetachedWindow({ onExecute, onReload, onFormatSql });

    document.querySelector<HTMLButtonElement>('[data-testid="content-execute"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-testid="content-reload"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-testid="toolbar-format"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-testid="toolbar-execute"]')?.click();
    await nextTick();

    expect(onExecute).toHaveBeenNthCalledWith(1, "SELECT 2");
    expect(onExecute).toHaveBeenNthCalledWith(2, "SELECT 1");
    expect(onReload).toHaveBeenCalledWith("SELECT 3");
    expect(onFormatSql).toHaveBeenCalledOnce();
  });
});
