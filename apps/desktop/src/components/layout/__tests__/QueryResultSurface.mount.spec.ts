// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ContentArea.vue", () => ({
  default: {
    name: "ContentAreaStub",
    props: ["activeTab", "activeConnection", "executableSql", "activeOutputView", "formatSqlRequest", "compressSqlRequest", "selectedSql", "cursorPos", "blockDangerousRedisCommands"],
    emits: ["previewStatement", "focusStatement", "reload"],
    template: `<div><button data-test="emit-preview" @click="$emit('previewStatement', 'tab-1', { from: 0, to: 8 })">preview</button><button data-test="emit-focus" @click="$emit('focusStatement', 'tab-1', { from: 0, to: 8 })">focus</button><button data-test="emit-reload" @click="$emit('reload', 'SELECT 1')">reload</button></div>`,
  },
}));

import QueryResultSurface from "../QueryResultSurface.vue";

function createHost(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

describe("QueryResultSurface mount contract", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("forwards preview and focus statement events to the parent", async () => {
    const host = createHost();
    const onPreviewStatement = vi.fn();
    const onFocusStatement = vi.fn();

    const app = createApp(QueryResultSurface, {
      activeTab: {
        id: "tab-1",
        title: "SQL",
        connectionId: "conn-1",
        database: "db",
        sql: "SELECT 1",
        mode: "query",
      },
      activeConnection: undefined,
      executableSql: "SELECT 1",
      activeOutputView: "result",
      formatSqlRequest: null,
      compressSqlRequest: null,
      selectedSql: "",
      cursorPos: 0,
      blockDangerousRedisCommands: false,
      onPreviewStatement,
      onFocusStatement,
    });
    app.mount(host);
    await nextTick();

    host.querySelector<HTMLButtonElement>('[data-test="emit-preview"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-test="emit-focus"]')?.click();
    await nextTick();

    expect(onPreviewStatement).toHaveBeenCalledWith("tab-1", { from: 0, to: 8 });
    expect(onFocusStatement).toHaveBeenCalledWith("tab-1", { from: 0, to: 8 });

    app.unmount();
    host.remove();
  });

  it("forwards generic reload events to the parent", async () => {
    const host = createHost();
    const onReload = vi.fn();

    const app = createApp(QueryResultSurface, {
      activeTab: {
        id: "tab-1",
        title: "SQL",
        connectionId: "conn-1",
        database: "db",
        sql: "SELECT 1",
        mode: "query",
      },
      activeConnection: undefined,
      executableSql: "SELECT 1",
      activeOutputView: "result",
      formatSqlRequest: null,
      compressSqlRequest: null,
      selectedSql: "",
      cursorPos: 0,
      blockDangerousRedisCommands: false,
      onReload,
    });
    app.mount(host);
    await nextTick();

    host.querySelector<HTMLButtonElement>('[data-test="emit-reload"]')?.click();
    await nextTick();

    expect(onReload).toHaveBeenCalledWith("SELECT 1");

    app.unmount();
    host.remove();
  });
});
