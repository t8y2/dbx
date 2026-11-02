// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, QueryTab } from "@/types/database";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  schema: "APP" as string | undefined,
}));

vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ObjectBrowser.vue", () => ({
  __esModule: true,
  default: defineComponent({
    props: { catalog: String },
    setup(props, { expose }) {
      expose({
        focusSearch: () => false,
        refresh: mocks.refresh,
        matchesRefreshScope: (scope: { schema?: string; catalog?: string }) => (mocks.schema || "") === (scope.schema || "") && (props.catalog || "") === (scope.catalog || ""),
      });
      return () => h("div", { "data-test": "object-browser" });
    },
  }),
}));

import ContentArea from "../ContentArea.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

const connection = {
  id: "dameng",
  name: "Dameng",
  db_type: "dameng",
  host: "localhost",
  port: 5236,
  username: "SYSDBA",
  password: "",
} as ConnectionConfig;

beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.refresh.mockReturnValue(true);
  mocks.schema = "APP";
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  window.localStorage?.clear();
});

async function mountObjectBrowserTab() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useConnectionStore().connections = [connection];
  const tab = reactive<QueryTab>({
    id: "objects",
    title: "app objects",
    connectionId: connection.id,
    database: "app",
    mode: "objects",
    sql: "",
    isExecuting: false,
  });
  useQueryStore().tabs.push(tab);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    setup: () => () =>
      h(ContentArea, {
        activeTab: tab,
        activeConnection: connection,
        activeOutputView: "result",
        executableSql: "",
        formatSqlRequest: null,
        compressSqlRequest: null,
        selectedSql: "",
        cursorPos: 0,
        blockDangerousRedisCommands: false,
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ app, host });
  await vi.waitFor(() => expect(host.querySelector('[data-test="object-browser"]')).not.toBeNull());
  return { tab };
}

function dispatchRefresh(detail: { connectionId?: string; database?: string; schema?: string; catalog?: string }) {
  window.dispatchEvent(new CustomEvent("dbx-refresh-object-browser", { detail }));
}

describe("ContentArea object browser refresh notifications", () => {
  it("refreshes an object tab using the schema selected inside ObjectBrowser", async () => {
    await mountObjectBrowserTab();

    dispatchRefresh({ connectionId: connection.id, database: "app", schema: "APP" });
    await nextTick();

    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it.each([
    { connectionId: "other", database: "app", schema: "APP" },
    { connectionId: connection.id, database: "other", schema: "APP" },
    { connectionId: connection.id, database: "app", schema: "OTHER" },
    { connectionId: connection.id, database: "app", schema: "APP", catalog: "OTHER" },
  ])("ignores a refresh outside the active browser scope: %o", async (detail) => {
    await mountObjectBrowserTab();

    dispatchRefresh(detail);
    await nextTick();

    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("rechecks the ObjectBrowser scope before the deferred refresh", async () => {
    await mountObjectBrowserTab();

    dispatchRefresh({ connectionId: connection.id, database: "app", schema: "APP" });
    mocks.schema = "OTHER";
    await nextTick();

    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
