// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import type { PlDebugSnapshot } from "@/lib/debug/plDebugProtocol";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { useSettingsStore } from "@/stores/settingsStore";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn(), isDebugLoggingEnabled: () => false }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [], getConfig: () => ({ db_type: "oracle" }) }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: { execute: () => Promise<unknown> }) => options.execute() }));
vi.mock("@/stores/settingsStore", async () => {
  const { reactive } = await import("vue");
  const settings = reactive({ editorSettings: { theme: "light", fontSize: 14, fontFamily: "monospace", shortcuts: {} } });
  return { useSettingsStore: () => settings };
});
vi.mock("@/lib/editor/editorThemes", () => ({ loadEditorTheme: async () => [], editorFontTheme: () => [] }));
vi.mock("@/composables/useTheme", async () => {
  const { ref } = await import("vue");
  return { useTheme: () => ({ isDark: ref(false), themePalette: ref({}) }) };
});

import PlDebugSourceEditor from "../PlDebugSourceEditor.vue";
import { usePlDebugStore } from "@/stores/plDebugStore";

let app: App;
let root: HTMLDivElement;
let pinia: ReturnType<typeof createPinia>;
let store: ReturnType<typeof usePlDebugStore>;

beforeEach(async () => {
  useSettingsStore().editorSettings.shortcuts = {};
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("native source must not use an ordinary dictionary query");
    }),
  );
  pinia = createPinia();
  setActivePinia(pinia);
  store = usePlDebugStore();
  store.debugId = "original";
  store.connectionId = "conn";
  store.database = "APP";
  store.target = { objectType: "PROCEDURE", objectName: "launch label", schema: "APP", packageName: null, source: null };
  store.publicSnapshot = { stopRevision: 7, state: "paused" } as PlDebugSnapshot;
  store.status = {
    sourceMappingState: "verified",
    frames: [
      {
        nativeFrameId: 2,
        line: 2,
        program: "different runtime",
        sourceState: "resolved",
        sourceRef: {
          id: "source:1",
          sourceRevision: 1,
          stopRevision: 7,
          nativeFrameId: 2,
          lineBasis: "all_source",
          identityState: "native",
          evidenceKind: "runtime",
          objectType: "PROCEDURE",
          owner: "APP",
          name: "Different\nName",
          source: "PROCEDURE exact AS\nBEGIN NULL;\nEND;",
        },
      },
    ],
  };
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(PlDebugSourceEditor);
  app.use(pinia).mount(root);
  await nextTick();
  await nextTick();
});

afterEach(() => {
  app.unmount();
  root.remove();
  disposePinia(pinia);
  vi.unstubAllGlobals();
});

it("renders the verified frame source instead of the launch label and highlights its native line", () => {
  expect(root.querySelector(".cm-content")?.textContent).toBe("PROCEDURE exact ASBEGIN NULL;END;");
  expect(root.querySelector(".cm-pl-debug-current-line")?.textContent).toBe("BEGIN NULL;");
  expect(fetch).not.toHaveBeenCalled();
});

it("dispatches step keys from the mounted editor and applies rebindings without remounting", async () => {
  const editor = root.querySelector(".cm-editor") as HTMLElement;
  const view = EditorView.findFromDOM(editor)!;
  const step = vi.spyOn(store, "stepIn").mockResolvedValue({});
  const modifier = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
  expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "i", ...modifier }), "editor")).toBe(true);
  expect(step).toHaveBeenCalledTimes(1);
  useSettingsStore().editorSettings.shortcuts = { stepInto: "Ctrl+Alt+J" };
  await nextTick();
  await nextTick();
  runScopeHandlers(view, new KeyboardEvent("keydown", { key: "i", ...modifier }), "editor");
  expect(step).toHaveBeenCalledTimes(1);
  expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "j", ctrlKey: true, altKey: true }), "editor")).toBe(true);
  expect(step).toHaveBeenCalledTimes(2);
  expect(EditorView.findFromDOM(editor)).toBe(view);
  store.busy = true;
  runScopeHandlers(view, new KeyboardEvent("keydown", { key: "j", ctrlKey: true, altKey: true }), "editor");
  expect(step).toHaveBeenCalledTimes(2);
});

it("clears a stale source reference without a dictionary fallback", async () => {
  store.publicSnapshot!.stopRevision = 8;
  await nextTick();
  await nextTick();
  expect(root.textContent).toContain("plDebug.source.unavailable");
  expect(root.querySelector(".cm-content")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("retains frozen source but clears the execution highlight while a control is pending", async () => {
  store.busy = true;
  await nextTick();
  expect(root.querySelector(".cm-content")).not.toBeNull();
  expect(root.querySelector(".cm-pl-debug-current-line")).toBeNull();
});

it("switches to the selected outer frame's exact source rather than reusing the top frame", async () => {
  const top = store.status!.frames![0]!;
  store.status!.frames!.push({ ...top, nativeFrameId: 1, line: 1, sourceRef: { ...top.sourceRef!, id: "outer:source", nativeFrameId: 1, source: "BEGIN outer_call;\nEND;" } });
  store.currentFrame = 1;
  await nextTick();
  await nextTick();
  expect(root.querySelector(".cm-content")?.textContent).toBe("BEGIN outer_call;END;");
  expect(root.querySelector(".cm-pl-debug-current-line")?.textContent).toBe("BEGIN outer_call;");
  expect(fetch).not.toHaveBeenCalled();
});
