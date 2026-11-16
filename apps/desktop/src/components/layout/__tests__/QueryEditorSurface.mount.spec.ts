// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ContentArea.vue", () => ({
  default: {
    name: "ContentAreaStub",
    props: ["activeTab", "activeConnection", "executableSql", "activeOutputView", "formatSqlRequest", "compressSqlRequest", "selectedSql", "cursorPos", "blockDangerousRedisCommands"],
    emits: ["execute", "saveSql"],
    template: `<button data-test="emit-execute" @click="$emit('execute', { fullSql: 'SELECT 1', selectedSql: 'SELECT 1', cursorPos: 0, selectionFrom: 0, selectionTo: 8 })">emit</button><button data-test="emit-save" @click="$emit('saveSql', 'tab-1')">save</button>`,
  },
}));

import QueryEditorSurface from "../QueryEditorSurface.vue";

function createHost(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

describe("QueryEditorSurface mount contract", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("forwards child ContentArea execute events to the parent", async () => {
    const host = createHost();
    const onExecute = vi.fn();

    const app = createApp(QueryEditorSurface, {
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
      autoFocus: false,
      onExecute,
    });
    app.mount(host);
    await nextTick();

    const button = host.querySelector<HTMLButtonElement>('[data-test="emit-execute"]');
    expect(button).not.toBeNull();
    button?.click();
    await nextTick();

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute.mock.calls[0]?.[0]).toMatchObject({ fullSql: "SELECT 1" });

    app.unmount();
    host.remove();
  });

  it("forwards child ContentArea saveSql events with the tab id", async () => {
    const host = createHost();
    const onSaveSql = vi.fn();

    const app = createApp(QueryEditorSurface, {
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
      autoFocus: false,
      onSaveSql,
    });
    app.mount(host);
    await nextTick();

    host.querySelector<HTMLButtonElement>('[data-test="emit-save"]')?.click();
    await nextTick();

    expect(onSaveSql).toHaveBeenCalledWith("tab-1");

    app.unmount();
    host.remove();
  });
});
