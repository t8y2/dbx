// @vitest-environment happy-dom

import { KeepAlive, createApp, defineComponent, h, nextTick, reactive, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { draftFromDetails, emptyDraft } from "@/lib/database/customTypeDraft";
import type { ConnectionConfig, CustomTypeDetails, CustomTypeEditorSession } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  ensureConnected: vi.fn(),
  previewCustomTypeChange: vi.fn(),
  getCustomTypeDetails: vi.fn(),
  sessionChange: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  getCustomTypeDetails: (...args: unknown[]) => mocks.getCustomTypeDetails(...args),
  getCustomTypeManagementCapabilities: vi.fn().mockResolvedValue({ operations: {}, capabilityRevision: "cap" }),
  listDataTypes: vi.fn().mockResolvedValue(["text"]),
  previewCustomTypeChange: (...args: unknown[]) => mocks.previewCustomTypeChange(...args),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: () => connection,
    orderByPinnedTreeNodes: (rows: unknown[]) => rows,
  }),
}));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ setCustomTypeDraftDirty: vi.fn() }) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      shortcuts: { refreshData: "F5" },
      objectBrowserViewMode: "grid",
      objectBrowserShowCheckbox: false,
    },
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install: () => undefined } }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("vue-virtual-scroller", () => ({ RecycleScroller: { render: () => null } }));
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: { render: () => null } }));
vi.mock("@/components/ui/ToolbarOverflowMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/ui/CustomContextMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));

vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/MySqlEventEditor.vue", () => ({ default: { render: () => null } }));

const connection = {
  id: "pg-types",
  name: "PostgreSQL",
  db_type: "postgres",
  database: "app",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listObjects.mockResolvedValue([]);
  mocks.listSchemas.mockResolvedValue([]);
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.getCustomTypeDetails.mockResolvedValue(enumDetails());
  mocks.previewCustomTypeChange.mockResolvedValue({ statements: [], blockedChanges: [], warnings: [], destructive: false, transactionPolicy: "autocommit", planRevision: "rev", resultingIdentity: { schema: "app", name: "status", kind: "enum" } });
  invalidateObjectBrowserRowsCache({});
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
});

async function mountBrowser(overrides: Partial<InstanceType<typeof ObjectBrowser>["$props"]> = {}) {
  const props = reactive({ connection, database: "app", ...overrides });
  const browser = ref<InstanceType<typeof ObjectBrowser> | null>(null);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { ...props, ref: browser }) });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledOnce());
  await nextTick();
  return { browser, host, props };
}

function enumDetails(): CustomTypeDetails {
  return {
    schema: "app",
    name: "status",
    kind: "enum",
    snapshotRevision: "original-snapshot",
    members: [{ name: "", dataType: "", ordinal: 1, enumValue: "draft" }],
    properties: { domainConstraints: [] },
  };
}

function dirtySession(): CustomTypeEditorSession {
  const details = enumDetails();
  const originalDraft = draftFromDetails(details);
  return {
    sourceRequestId: 1,
    mode: "edit",
    schema: "app",
    name: "status",
    details,
    originalDraft,
    draft: { ...draftFromDetails(details), name: "unsaved_status" },
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

const nameSelector = '[aria-label="customType.editor.namePlaceholder"]';

describe("ObjectBrowser custom type sessions", () => {
  it.each(["edit", "create"] as const)("opens the first sidebar %s request after context initialization", async (mode) => {
    const { host } = await mountBrowser({
      initialCustomTypeRequest: { mode, schema: "app", name: mode === "create" ? "" : "status", requestId: 1 },
    });
    await vi.waitFor(() => expect(host.querySelector<HTMLInputElement>(nameSelector)?.value).toBe(mode === "create" ? "" : "status"));
    if (mode === "edit") expect(mocks.getCustomTypeDetails).toHaveBeenCalledWith("pg-types", "app", "app", "status");
  });

  it("restores a dirty session on parent remount without replacing its snapshot", async () => {
    const { host } = await mountBrowser({
      initialCustomTypeRequest: { mode: "edit", schema: "app", name: "status", requestId: 1 },
      customTypeSession: dirtySession(),
      onCustomTypeSessionChange: mocks.sessionChange,
    });
    await vi.waitFor(() => expect(host.querySelector<HTMLInputElement>(nameSelector)?.value).toBe("unsaved_status"));
    expect(mocks.getCustomTypeDetails).not.toHaveBeenCalled();
    expect(mocks.sessionChange.mock.calls.at(-1)![0].details.snapshotRevision).toBe("original-snapshot");
    expect(mocks.previewCustomTypeChange.mock.calls.at(-1)![2].expectedSnapshotRevision).toBe("original-snapshot");
  });

  it("starts a fresh toolbar draft after a restored draft is explicitly discarded", async () => {
    const previousConfirm = window.confirm;
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    mocks.listObjects.mockResolvedValue([{ name: "status", schema: "app", object_type: "TYPE" }]);
    const session: CustomTypeEditorSession & { sourceRequestId: number } = {
      sourceRequestId: 0,
      mode: "create",
      schema: "app",
      name: "",
      details: null,
      originalDraft: null,
      draft: { ...emptyDraft("enum", "app"), name: "unsaved_status" },
    };
    try {
      const { host, props } = await mountBrowser({
        customTypeSession: session,
        selectedObjectFilter: "types",
        onCustomTypeSessionChange: mocks.sessionChange,
      });
      await vi.waitFor(() => expect(host.querySelector<HTMLInputElement>(nameSelector)?.value).toBe("unsaved_status"));

      // Declining the discard must leave the live draft intact.
      host.querySelector<HTMLButtonElement>('button[title="common.close"]')!.click();
      await flush();
      expect(confirm).toHaveBeenCalledOnce();
      expect(host.querySelector<HTMLInputElement>(nameSelector)?.value).toBe("unsaved_status");

      confirm.mockReturnValue(true);
      host.querySelector<HTMLButtonElement>('button[title="common.close"]')!.click();
      await flush();
      expect(host.querySelector(nameSelector)).toBeNull();
      expect(mocks.sessionChange.mock.calls.at(-1)![0]).toBeNull();
      // Mirror the tab store clearing the session. Toolbar sessions have no
      // sidebar request id whose watcher could also clear the restore state.
      props.customTypeSession = undefined;
      await flush();

      host.querySelector<HTMLButtonElement>('button[title="contextMenu.createType"]')!.click();
      await vi.waitFor(() => expect(host.querySelector<HTMLInputElement>(nameSelector)?.value).toBe(""));
      expect(mocks.sessionChange.mock.calls.at(-1)![0].draft.name).toBe("");
    } finally {
      window.confirm = previousConfirm;
    }
  });

  it("preserves a cached dirty draft if a different sidebar request is declined", async () => {
    const previous = window.confirm;
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    try {
      const { host } = await mountBrowser({
        initialCustomTypeRequest: { mode: "edit", schema: "app", name: "other", requestId: 2 },
        customTypeSession: dirtySession(),
        onCustomTypeSessionChange: mocks.sessionChange,
      });
      await vi.waitFor(() => expect(host.querySelector<HTMLInputElement>(nameSelector)?.value).toBe("unsaved_status"));
      expect(confirm).toHaveBeenCalledOnce();
      expect(mocks.getCustomTypeDetails).not.toHaveBeenCalled();
      expect(mocks.sessionChange.mock.calls.at(-1)![0].name).toBe("status");
    } finally {
      window.confirm = previous;
    }
  });

  it("restores the real browser and panel after KeepAlive evicts the browser", async () => {
    const active = ref(0);
    const session = ref<CustomTypeEditorSession | null>(null);
    const Dummy = defineComponent({ render: () => h("div", "other tab") });
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({
      setup: () => () =>
        h(
          KeepAlive,
          { max: 3 },
          {
            default: () =>
              active.value === 0
                ? h(ObjectBrowser, {
                    key: "types",
                    connection,
                    database: "app",
                    initialCustomTypeRequest: { mode: "edit", schema: "app", name: "status", requestId: 1 },
                    customTypeSession: session.value,
                    onCustomTypeSessionChange: (value: CustomTypeEditorSession | null) => {
                      session.value = value;
                    },
                  })
                : h(Dummy, { key: `other:${active.value}` }),
          },
        ),
    });
    mountedApps.push({ app, host });
    app.mount(host);
    await vi.waitFor(() => expect(host.querySelector(nameSelector)).not.toBeNull());
    await flush();
    const input = host.querySelector<HTMLInputElement>(nameSelector)!;
    input.value = "unsaved_status";
    input.dispatchEvent(new Event("input"));
    await flush();
    expect(session.value?.draft?.name).toBe("unsaved_status");
    for (const id of [1, 2, 3]) {
      active.value = id;
      await flush();
    }
    mocks.getCustomTypeDetails.mockResolvedValue({ ...enumDetails(), snapshotRevision: "new-snapshot" });
    active.value = 0;
    await vi.waitFor(() => expect(host.querySelector<HTMLInputElement>(nameSelector)?.value).toBe("unsaved_status"));
    expect(mocks.getCustomTypeDetails).toHaveBeenCalledOnce();
    expect(session.value?.details?.snapshotRevision).toBe("original-snapshot");
    expect(mocks.previewCustomTypeChange.mock.calls.at(-1)![2].expectedSnapshotRevision).toBe("original-snapshot");
  });
});
