// @vitest-environment happy-dom

import { CompletionContext, insertCompletionText, snippetCompletion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createPinia, setActivePinia } from "pinia";
import { computed, reactive, shallowRef } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useQueryEditorCompletion } from "../useQueryEditorCompletion";
import { useQueryEditorCompletionMetadata } from "../useQueryEditorCompletionMetadata";
import type { QueryEditorProps } from "../queryEditorTypes";
import type { CompletionAssistantRequest, ConnectionConfig } from "@/types/database";

const api = vi.hoisted(() => ({
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  completionAssistantSearch: vi.fn(),
  listCompletionObjects: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => api);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

type Options = Parameters<typeof useQueryEditorCompletion>[0];
const cleanups: Array<() => void> = [];

beforeEach(() => {
  setActivePinia(createPinia());
  api.completionAssistantSearch.mockReset().mockResolvedValue({ candidates: [], incomplete: false, fallback_used: true });
  api.listCompletionObjects.mockReset().mockResolvedValue([{ name: "RUN", schema: "APP", object_type: "PROCEDURE" }]);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createEditor(sql = "CALL APP.R") {
  const connectionStore = useConnectionStore();
  connectionStore.connections = [{ id: "legacy-ob", name: "OB", db_type: "oceanbase-oracle", database: "OB", username: "CURRENT", transport_layers: [] } as unknown as ConnectionConfig];
  connectionStore.connectedIds.add("legacy-ob");
  const props = reactive<QueryEditorProps>({ connectionId: "legacy-ob", database: "OB", schema: "CURRENT", databaseType: "oceanbase-oracle", dialect: "oracle", modelValue: sql });
  const parent = document.createElement("div");
  document.body.append(parent);
  const currentView = new EditorView({ parent, state: EditorState.create({ doc: sql, selection: { anchor: sql.length } }) });
  const view = shallowRef<EditorView | null>(currentView);
  const metadata = useQueryEditorCompletionMetadata({ props, view, connectionStore, sqlBehaviorDialect: () => props.dialect, remoteLatencyBudgetMs: 100, maxCompletionTables: 100, onDemandMinPrefix: 2, semanticCompletionEnabled: false });
  const completion = useQueryEditorCompletion({
    props,
    view,
    connectionStore,
    settingsStore: useSettingsStore(),
    sqlDriverProfile: computed(() => undefined),
    t: ((key: string) => key) as Options["t"],
    metadata,
    runtime: { codeMirrorInsertCompletionText: insertCompletionText, codeMirrorSnippetCompletion: snippetCompletion, codeMirrorCompletionStatus: () => null, imeCompositionActive: false },
    batchSelection: {
      clearBatchColumnSelectionSession: () => undefined,
      prepareBatchColumnSelectionSession: () => null,
      isBatchColumnSelectionAction: () => false,
      batchColumnSelectionMarkerForItem: () => undefined,
      cacheBatchColumnSelectionOption: (_marker: unknown, option: unknown) => option,
    } as unknown as Options["batchSelection"],
    isEditorComposing: () => false,
    debounceDelayMs: 1,
    triggerDeferDelayMs: 1,
    maxCompletionTables: 100,
    onDemandTableLimit: 100,
    semanticCompletionEnabled: false,
  });
  cleanups.push(() => {
    completion.invalidateRequests();
    currentView.destroy();
    parent.remove();
  });
  return () => completion.provideSqlCompletions(new CompletionContext(currentView.state, sql.length, true));
}

it.each([null, "OceanBase agent does not support filtered routine completion; update the agent", "Unknown method: completion_assistant_search", "Method not found"])("retains schema routines from the real Store fallback when the old Agent cannot search packages: %s", async (error) => {
  if (error)
    api.completionAssistantSearch.mockImplementation(async (request: CompletionAssistantRequest) => {
      if (request.object_kinds.includes("procedure")) throw new Error(error);
      return { candidates: [], incomplete: false, fallback_used: false };
    });
  const provide = createEditor();
  const result = await provide();
  expect(result?.options.some((option) => option.label === "RUN")).toBe(true);
  expect(api.listCompletionObjects).toHaveBeenCalledWith("legacy-ob", "OB", "APP");
  expect(api.completionAssistantSearch.mock.calls.some(([request]) => request.parent_name === "APP")).toBe(true);
});

it("does not fabricate package members from the old Agent's standalone fallback", async () => {
  const result = await createEditor("CALL CURRENT.PKG.R")();
  expect(result?.options.some((option) => option.label === "RUN") ?? false).toBe(false);
  expect(api.listCompletionObjects).not.toHaveBeenCalled();
});

it.each(["ORA-01031: insufficient privileges", "Network connection lost", "Network transport not supported", "Request timed out"])("does not hide a failed package probe: %s", async (message) => {
  api.completionAssistantSearch.mockImplementation(async (request: CompletionAssistantRequest) => {
    if (request.parent_name) throw new Error(message);
    return { candidates: [{ name: "RUN", schema: "APP", kind: "procedure" }], incomplete: false, fallback_used: false };
  });
  expect(await createEditor()()).toBeNull();
});

it("does not convert two failed interpretations into successful completion", async () => {
  api.completionAssistantSearch.mockRejectedValue(new Error("Network connection lost"));
  expect(await createEditor()()).toBeNull();
});

it("suggests sequence pseudo-columns for schema-qualified OceanBase sequences when package probe reports not visible", async () => {
  api.completionAssistantSearch.mockImplementation(async (request: CompletionAssistantRequest) => {
    if (request.parent_name) throw new Error("Package is not visible: APP.ORDER_SEQ");
    return {
      candidates: [{ name: "ORDER_SEQ", schema: "APP", kind: "sequence" }],
      incomplete: false,
      fallback_used: false,
    };
  });
  const provide = createEditor("SELECT APP.ORDER_SEQ.");
  const result = await provide();
  expect(result?.options.some((option) => option.label === "NEXTVAL")).toBe(true);
  expect(result?.options.some((option) => option.label === "CURRVAL")).toBe(true);
});

it("suggests sequence pseudo-columns for unqualified sequence in current schema", async () => {
  api.completionAssistantSearch.mockImplementation(async (request: CompletionAssistantRequest) => {
    if (request.parent_name) throw new Error("Package is not visible: CURRENT.ORDER_SEQ");
    return {
      candidates: [{ name: "ORDER_SEQ", schema: "CURRENT", kind: "sequence" }],
      incomplete: false,
      fallback_used: false,
    };
  });
  const provide = createEditor("SELECT ORDER_SEQ.");
  const result = await provide();
  expect(result?.options.some((option) => option.label === "NEXTVAL")).toBe(true);
  expect(result?.options.some((option) => option.label === "CURRVAL")).toBe(true);
});
