// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSettingsStore, DEFAULT_EDITOR_SETTINGS, DEFAULT_DESKTOP_SETTINGS } from "@/stores/settingsStore";
import { useConnectionStore, type ConnectionConfig } from "@/stores/connectionStore";
import { useQueryStore, type QueryTab } from "@/stores/queryStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useSqlExecution } from "@/composables/useSqlExecution";
import { computed } from "vue";

vi.mock("vue-i18n", async () => {
  const { ref } = await import("vue");
  const locale = ref("en");
  const t = (key: string) => key;
  return {
    createI18n: () => ({ global: { t, locale }, install: () => undefined }),
    useI18n: () => ({ t, locale }),
  };
});

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return {
    Dialog: defineComponent({
      props: { open: { type: Boolean, default: false } },
      setup:
        (props, { slots }) =>
        () =>
          props.open ? h("div", slots.default?.()) : null,
    }),
    DialogContent: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
  };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      setup(props, { attrs, slots }) {
        return () => h("button", { ...attrs, disabled: (props as { disabled?: boolean }).disabled ? true : undefined }, slots.default?.());
      },
      props: { disabled: { type: Boolean, default: false } },
    }),
  };
});

vi.mock("@/components/ui/switch", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Switch: defineComponent({
      props: { id: String, modelValue: Boolean, disabled: Boolean },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () =>
          h("button", {
            id: props.id,
            role: "switch",
            "aria-checked": props.modelValue,
            disabled: props.disabled,
            onClick: () => emit("update:modelValue", !props.modelValue),
          });
      },
    }),
  };
});

let selectEmitMap = new Map<string, (val: any) => void>();

vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const Select = defineComponent({
    props: { modelValue: { type: [String, Number], default: "" } },
    emits: ["update:modelValue"],
    setup(props, { emit, slots }) {
      selectEmitMap.set("current", (val) => emit("update:modelValue", val));
      return () => h("div", { "data-select-value": props.modelValue }, slots.default?.());
    },
  });
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  const SelectItem = defineComponent({
    props: { value: String },
    setup(props, { slots }) {
      return () =>
        h(
          "button",
          {
            "data-item-value": props.value,
            onClick: () => selectEmitMap.get("current")?.(props.value),
          },
          slots.default?.(),
        );
    },
  });
  return {
    Select,
    SelectContent: passthrough,
    SelectItem,
    SelectTrigger: passthrough,
    SelectValue: passthrough,
  };
});

vi.mock("@/components/settings/ChangelogPanel.vue", async () => {
  const { defineComponent } = await import("vue");
  return { default: defineComponent({ setup: () => () => null }) };
});

const hoisted = vi.hoisted(() => ({
  savedEditorSettings: [] as any[],
}));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    loadEditorSettings: async () => null,
    saveEditorSettings: async (settings: any) => {
      hoisted.savedEditorSettings.push(JSON.parse(JSON.stringify(settings)));
    },
    loadHistoryRetentionLimit: async () => 5000,
    loadMcpHistoryRetentionLimit: async () => 5000,
    loadMcpGlobalPolicy: async () => null,
    loadDesktopSettings: async () => null,
    loadAiConfigs: async () => [],
    loadAiConfig: async () => null,
    loadAiProviderConfigs: async () => ({}),
    loadAiChatSelection: async () => null,
    webdavSyncSecretsStatus: async () => ({}),
    webdavPasswordStatus: async () => ({}),
    snippetTokenStatus: async () => ({ hasSavedToken: false }),
    snippetPassphraseStatus: async () => ({ hasSavedPassphrase: false }),
    snippetSavedTokenStatus: async () => ({}),
    snippetSyncSettings: async () => ({}),
    getAppSupportInfo: async () => {
      throw new Error("unavailable in tests");
    },
    listInstalledAgentsLocal: async () => [],
    checkMcpServerStatus: async () => {
      throw new Error("unavailable in tests");
    },
  };
});

import EditorSettingsDialog from "../EditorSettingsDialog.vue";

if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  document.body.innerHTML = "";
});

async function settle() {
  for (let i = 0; i < 10; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

function connection(id: string, db_type: any): ConnectionConfig {
  return {
    id,
    name: id,
    db_type,
    host: "127.0.0.1",
    port: 5432,
    user: "postgres",
    database: "demo",
    save_password: false,
  };
}

function queryTab(id: string, connectionId: string, databaseType: any, sql: string): QueryTab {
  return {
    id,
    title: id,
    query: sql,
    sql,
    connectionId,
    databaseType,
    database: "demo",
    isExecuting: false,
    historyIndex: 0,
    history: [],
  };
}

describe("EditorSettingsDialog SQL variable syntax integration", () => {
  beforeEach(() => {
    hoisted.savedEditorSettings = [];
  });

  it("openGauss: previously saved substitution=false -> UI toggles shell=false in B mode -> preserves substitution=false -> executes in A mode without parameter prompt", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);

    const settingsStore = useSettingsStore();
    const connectionStore = useConnectionStore();
    const queryStore = useQueryStore();

    // 1. Initial state: user previously saved opengauss.substitution = false
    settingsStore.editorSettings = {
      ...DEFAULT_EDITOR_SETTINGS,
      sqlVariableSyntaxOverrides: {
        opengauss: { substitution: false },
      },
    };
    settingsStore.desktopSettings = { ...DEFAULT_DESKTOP_SETTINGS };

    // 2. Active connection is openGauss in B mode
    const conn = connection("conn-og-b", "opengauss");
    connectionStore.connections = [conn];
    connectionStore.activeConnectionId = conn.id;
    const tab = queryTab("tab-1", conn.id, "opengauss", "SELECT * FROM t WHERE col = &var;");
    queryStore.tabs = [tab];
    queryStore.activeTabId = tab.id;

    const modeSpy = vi.spyOn(connectionStore, "databaseCompatibilityMode").mockReturnValue("B");

    // 3. Mount EditorSettingsDialog on the 'editor' tab
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(
      defineComponent({
        setup: () => () => h(EditorSettingsDialog, { variant: "page", open: true, initialTab: "editor", "onUpdate:open": () => undefined }),
      }),
    );
    app.use(pinia);
    app.mount(host);
    mountedApps.push({ app, host });
    await settle();

    // 4. In the dialog, select openGauss
    const ogOption = host.querySelector<HTMLButtonElement>('[data-item-value="opengauss"]');
    expect(ogOption).toBeTruthy();
    ogOption!.click();
    await settle();

    // Switch the shell toggle to false
    const shellSwitch = host.querySelector<HTMLButtonElement>("#sql-var-syntax-shell");
    expect(shellSwitch).toBeTruthy();
    shellSwitch!.click();
    await settle();

    // 5. Click the Apply button
    const applyBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "settings.apply");
    expect(applyBtn).toBeTruthy();
    expect(applyBtn!.disabled).toBe(false);
    applyBtn!.click();
    await settle();

    // 6. Verify persistence: substitution: false was preserved alongside shell: false!
    expect(settingsStore.editorSettings.sqlVariableSyntaxOverrides.opengauss).toEqual({
      substitution: false,
      shell: false,
    });

    // 7. Execution in A mode: active connection mode is switched to A mode
    modeSpy.mockReturnValue("A");
    const activeTab = ref<QueryTab | undefined>(tab);
    const activeConnection = ref<ConnectionConfig | undefined>(conn);
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");

    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => tab.sql),
      activeOutputView,
    });
    await execution.tryExecute();

    // Must NOT prompt parameter dialog because substitution: false was preserved!
    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(executeCurrentSql).toHaveBeenCalledWith(tab.sql, expect.anything());
  });

  it("Kingbase: previously saved substitution=false -> UI toggles shell=false in pg mode -> preserves substitution=false -> executes in oracle mode without parameter prompt", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);

    const settingsStore = useSettingsStore();
    const connectionStore = useConnectionStore();
    const queryStore = useQueryStore();

    // 1. Initial state: user previously saved kingbase.substitution = false
    settingsStore.editorSettings = {
      ...DEFAULT_EDITOR_SETTINGS,
      sqlVariableSyntaxOverrides: {
        kingbase: { substitution: false },
      },
    };
    settingsStore.desktopSettings = { ...DEFAULT_DESKTOP_SETTINGS };

    // 2. Active connection is Kingbase in pg mode
    const conn: ConnectionConfig = {
      ...connection("conn-kb-pg", "kingbase"),
      database_info: { compatibilityMode: "pg" },
    };
    connectionStore.connections = [conn];
    connectionStore.activeConnectionId = conn.id;
    const tab = queryTab("tab-kb", conn.id, "kingbase", "SELECT * FROM t WHERE col = &var;");
    queryStore.tabs = [tab];
    queryStore.activeTabId = tab.id;

    // 3. Mount EditorSettingsDialog on the 'editor' tab
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(
      defineComponent({
        setup: () => () => h(EditorSettingsDialog, { variant: "page", open: true, initialTab: "editor", "onUpdate:open": () => undefined }),
      }),
    );
    app.use(pinia);
    app.mount(host);
    mountedApps.push({ app, host });
    await settle();

    // 4. Select Kingbase
    const kbOption = host.querySelector<HTMLButtonElement>('[data-item-value="kingbase"]');
    expect(kbOption).toBeTruthy();
    kbOption!.click();
    await settle();

    // Toggle shell switch
    const shellSwitch = host.querySelector<HTMLButtonElement>("#sql-var-syntax-shell");
    expect(shellSwitch).toBeTruthy();
    shellSwitch!.click();
    await settle();

    // 5. Apply
    const applyBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "settings.apply");
    expect(applyBtn).toBeTruthy();
    expect(applyBtn!.disabled).toBe(false);
    applyBtn!.click();
    await settle();

    // 6. Verify persistence: substitution: false was preserved!
    expect(settingsStore.editorSettings.sqlVariableSyntaxOverrides.kingbase).toEqual({
      substitution: false,
      shell: false,
    });

    // 7. Execution in oracle mode
    const oracleConn: ConnectionConfig = {
      ...conn,
      database_info: { compatibilityMode: "oracle" },
    };
    const activeTab = ref<QueryTab | undefined>(tab);
    const activeConnection = ref<ConnectionConfig | undefined>(oracleConn);
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");

    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => tab.sql),
      activeOutputView,
    });
    await execution.tryExecute();

    // Must NOT prompt parameter dialog!
    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(executeCurrentSql).toHaveBeenCalledWith(tab.sql, expect.anything());
  });
});
