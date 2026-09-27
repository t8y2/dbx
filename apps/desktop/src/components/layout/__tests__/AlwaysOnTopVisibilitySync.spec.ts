// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createPinia, disposePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ desktop: true, current: { label: "main", alwaysOnTop: false } }));
const eventBus = vi.hoisted(() => ({
  listeners: new Set<{ event: string; windowLabel: string; handler: (event: { payload: unknown }) => void; unlisten: ReturnType<typeof vi.fn> }>(),
  deferVisibility: false,
  completeVisibility: null as (() => void) | null,
  registrationError: null as Error | null,
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => runtime.desktop }));
vi.mock("@/lib/backend/api", () => ({ loadEditorSettings: vi.fn(), saveEditorSettings: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    const state = runtime.current;
    return {
      label: state.label,
      isMaximized: async () => false,
      isFullscreen: async () => false,
      isAlwaysOnTop: async () => state.alwaysOnTop,
      setAlwaysOnTop: async (value: boolean) => {
        state.alwaysOnTop = value;
      },
      onResized: async () => () => {},
      onFocusChanged: async () => () => {},
    };
  },
}));

import { emit, listen } from "@tauri-apps/api/event";
import * as api from "@/lib/backend/api";
import { ALWAYS_ON_TOP_TOOLBAR_VISIBILITY_CHANGED_EVENT, WINDOW_ALWAYS_ON_TOP_CHANGED_EVENT } from "@/lib/app/windowAlwaysOnTop";
import { normalizeEditorSettings, useSettingsStore, type EditorSettings } from "@/stores/settingsStore";
import DetachedTabHeader from "../DetachedTabHeader.vue";

const PIN_ON_LABEL = "pin-window";
const PIN_OFF_LABEL = "unpin-window";
const cleanup: Array<() => void> = [];
let persistedSettings: EditorSettings;

function createStore() {
  const pinia = createPinia();
  cleanup.push(() => disposePinia(pinia));
  return { pinia, store: useSettingsStore(pinia) };
}

async function mountDetached(label: string, alwaysOnTop = false) {
  const { pinia, store } = createStore();
  await store.initEditorSettings();
  const state = { label, alwaysOnTop };
  runtime.current = state;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(DetachedTabHeader, { title: label });
  app.use(pinia);
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      missingWarn: false,
      fallbackWarn: false,
      messages: { en: { toolbar: { alwaysOnTop: PIN_ON_LABEL, alwaysOnTopOff: PIN_OFF_LABEL } } },
    }),
  );
  app.mount(host);
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    app.unmount();
    host.remove();
  };
  cleanup.push(unmount);
  if (runtime.desktop) {
    await vi.waitFor(() => expect([...eventBus.listeners].some((listener) => listener.windowLabel === label && listener.event === WINDOW_ALWAYS_ON_TOP_CHANGED_EVENT)).toBe(true));
  }
  return { host, store, state, unmount };
}

function pinButton(host: HTMLElement, label = PIN_ON_LABEL) {
  return host.querySelector(`[aria-label="${label}"]`);
}

function toolbarPatch(store: ReturnType<typeof useSettingsStore>, visible: boolean) {
  return { toolbarItems: { ...store.editorSettings.toolbarItems, alwaysOnTop: visible } };
}

describe("always-on-top toolbar visibility across windows", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.desktop = true;
    runtime.current = { label: "main", alwaysOnTop: false };
    eventBus.listeners.clear();
    eventBus.deferVisibility = false;
    eventBus.completeVisibility = null;
    eventBus.registrationError = null;
    persistedSettings = normalizeEditorSettings({});
    vi.mocked(api.loadEditorSettings).mockImplementation(async () => structuredClone(persistedSettings));
    vi.mocked(api.saveEditorSettings).mockImplementation(async (settings) => {
      persistedSettings = structuredClone(settings) as EditorSettings;
    });
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === ALWAYS_ON_TOP_TOOLBAR_VISIBILITY_CHANGED_EVENT && eventBus.registrationError) throw eventBus.registrationError;
      const entry = { event, windowLabel: runtime.current.label, handler: ({ payload }: { payload: unknown }) => handler({ event, id: 0, payload }), unlisten: vi.fn() };
      entry.unlisten.mockImplementation(() => eventBus.listeners.delete(entry));
      eventBus.listeners.add(entry);
      if (event === ALWAYS_ON_TOP_TOOLBAR_VISIBILITY_CHANGED_EVENT && eventBus.deferVisibility) {
        await new Promise<void>((resolve) => {
          eventBus.completeVisibility = resolve;
        });
      }
      return entry.unlisten;
    });
    vi.mocked(emit).mockImplementation(async (event, payload) => {
      for (const listener of eventBus.listeners) {
        if (listener.event === event) listener.handler({ payload });
      }
    });
  });

  afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) dispose();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("enables and disables already-open independent stores without replacing other settings or echoing", async () => {
    const { store: main } = createStore();
    await main.initEditorSettings();
    const first = await mountDetached("detached-tab-first");
    first.store.editorSettings.fontSize = 27;
    first.store.editorSettings.toolbarItems.github = false;
    expect(first.store).not.toBe(main);
    expect(pinButton(first.host)).toBeNull();

    main.updateEditorSettings(toolbarPatch(main, true));
    expect(first.store.editorSettings.toolbarItems.alwaysOnTop).toBe(false);
    await vi.waitFor(() => expect(pinButton(first.host)).not.toBeNull());
    const second = await mountDetached("detached-tab-second");
    expect(second.store).not.toBe(first.store);
    expect(pinButton(second.host)).not.toBeNull();
    expect(api.saveEditorSettings).toHaveBeenCalledTimes(1);

    main.updateEditorSettings(toolbarPatch(main, false));
    await vi.waitFor(() => {
      expect(pinButton(first.host)).toBeNull();
      expect(pinButton(second.host)).toBeNull();
    });
    expect(first.store.editorSettings.fontSize).toBe(27);
    expect(first.store.editorSettings.toolbarItems.github).toBe(false);
    expect(first.state.alwaysOnTop).toBe(false);
    expect(second.state.alwaysOnTop).toBe(false);
    expect(vi.mocked(emit).mock.calls).toEqual([
      [ALWAYS_ON_TOP_TOOLBAR_VISIBILITY_CHANGED_EVENT, true],
      [ALWAYS_ON_TOP_TOOLBAR_VISIBILITY_CHANGED_EVENT, false],
    ]);
    expect(api.saveEditorSettings).toHaveBeenCalledTimes(2);
    expect(api.loadEditorSettings).toHaveBeenCalledTimes(3);
  });

  it("does not rebroadcast a received value when saving an unrelated setting", async () => {
    const { store: main } = createStore();
    await main.initEditorSettings();
    const detached = await mountDetached("detached-tab-save");
    await main.updateEditorSettingsAndPersist(toolbarPatch(main, true));
    await detached.store.updateEditorSettingsAndPersist({ fontSize: 23 });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(api.saveEditorSettings).toHaveBeenCalledTimes(2);
    expect(main.editorSettings.fontSize).not.toBe(23);
  });

  it("keeps a pinned detached window's escape hatch until it is unpinned", async () => {
    const { store: main } = createStore();
    await main.initEditorSettings();
    await main.updateEditorSettingsAndPersist(toolbarPatch(main, true));
    const detached = await mountDetached("detached-tab-pinned", true);
    await main.updateEditorSettingsAndPersist(toolbarPatch(main, false));
    await nextTick();
    expect(detached.store.editorSettings.toolbarItems.alwaysOnTop).toBe(false);
    const unpin = pinButton(detached.host, PIN_OFF_LABEL);
    expect(unpin).not.toBeNull();
    unpin?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(detached.state.alwaysOnTop).toBe(false);
      expect(pinButton(detached.host, PIN_OFF_LABEL)).toBeNull();
      expect(pinButton(detached.host)).toBeNull();
    });
  });

  it("publishes saved snapshots in order rather than the current unsaved toggle", async () => {
    const { store: main } = createStore();
    await main.initEditorSettings();
    const detached = await mountDetached("detached-tab-queued");
    let completeSave!: () => void;
    vi.mocked(api.saveEditorSettings).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeSave = resolve;
        }),
    );
    main.updateEditorSettings(toolbarPatch(main, true));
    main.updateEditorSettings(toolbarPatch(main, false));
    expect(emit).not.toHaveBeenCalled();
    expect(pinButton(detached.host)).toBeNull();
    completeSave();
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
    expect(vi.mocked(emit).mock.calls.map((call) => call[1])).toEqual([true, false]);
    expect(detached.store.editorSettings.toolbarItems.alwaysOnTop).toBe(false);
    expect(main.editorSettings.toolbarItems.alwaysOnTop).toBe(false);
  });

  it("does not publish a failed optimistic save and propagates a successful retry", async () => {
    const { store: main } = createStore();
    await main.initEditorSettings();
    const detached = await mountDetached("detached-tab-retry");
    vi.mocked(api.saveEditorSettings).mockRejectedValueOnce(new Error("disk full"));
    main.updateEditorSettings(toolbarPatch(main, true));
    await nextTick();
    expect(main.editorSettings.toolbarItems.alwaysOnTop).toBe(true);
    expect(detached.store.editorSettings.toolbarItems.alwaysOnTop).toBe(false);
    expect(emit).not.toHaveBeenCalled();
    await main.persistEditorSettings();
    expect(detached.store.editorSettings.toolbarItems.alwaysOnTop).toBe(true);
    expect(emit).toHaveBeenCalledExactlyOnceWith(ALWAYS_ON_TOP_TOOLBAR_VISIBILITY_CHANGED_EVENT, true);
  });

  it.each([false, true])("retains atomic rollback and no notification on persistence failure from %s", async (initial) => {
    persistedSettings.toolbarItems.alwaysOnTop = initial;
    const { store: main } = createStore();
    await main.initEditorSettings();
    const detached = await mountDetached("detached-tab-failed");
    vi.mocked(api.saveEditorSettings).mockRejectedValueOnce(new Error("disk full"));
    await expect(main.updateEditorSettingsAndPersist(toolbarPatch(main, !initial))).rejects.toThrow("disk full");
    expect(main.editorSettings.toolbarItems.alwaysOnTop).toBe(initial);
    expect(detached.store.editorSettings.toolbarItems.alwaysOnTop).toBe(initial);
    expect(persistedSettings.toolbarItems.alwaysOnTop).toBe(initial);
    expect(emit).not.toHaveBeenCalled();
    await main.persistEditorSettings();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not roll back a successful save when event delivery fails", async () => {
    const { store: main } = createStore();
    await main.initEditorSettings();
    const detached = await mountDetached("detached-tab-delivery");
    const error = new Error("event unavailable");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(emit).mockRejectedValueOnce(error);
    await expect(main.updateEditorSettingsAndPersist(toolbarPatch(main, true))).resolves.toBeUndefined();
    expect(persistedSettings.toolbarItems.alwaysOnTop).toBe(true);
    expect(main.editorSettings.toolbarItems.alwaysOnTop).toBe(true);
    expect(detached.store.editorSettings.toolbarItems.alwaysOnTop).toBe(false);
    expect(log).toHaveBeenCalledWith("[DBX][window:always-on-top-toolbar-visibility-event]", error);
    await main.updateEditorSettingsAndPersist(toolbarPatch(main, false));
    expect(emit).toHaveBeenLastCalledWith(ALWAYS_ON_TOP_TOOLBAR_VISIBILITY_CHANGED_EVENT, false);
  });

  it("ignores nonboolean event payloads without persisting", async () => {
    const detached = await mountDetached("detached-tab-validation");
    for (const payload of [null, "true", 1, { visible: true }, { toolbarItems: { alwaysOnTop: true } }]) {
      await emit(ALWAYS_ON_TOP_TOOLBAR_VISIBILITY_CHANGED_EVENT, payload);
    }
    expect(detached.store.editorSettings.toolbarItems.alwaysOnTop).toBe(false);
    expect(api.saveEditorSettings).not.toHaveBeenCalled();
  });

  it("removes the listener on unmount and ignores stale callbacks", async () => {
    const detached = await mountDetached("detached-tab-cleanup");
    const listener = [...eventBus.listeners].find((entry) => entry.event === ALWAYS_ON_TOP_TOOLBAR_VISIBILITY_CHANGED_EVENT)!;
    detached.unmount();
    expect(listener.unlisten).toHaveBeenCalledTimes(1);
    expect(eventBus.listeners.size).toBe(0);
    listener.handler({ payload: true });
    expect(detached.store.editorSettings.toolbarItems.alwaysOnTop).toBe(false);
    expect(api.saveEditorSettings).not.toHaveBeenCalled();
  });

  it("cleans up registration that completes after unmount", async () => {
    eventBus.deferVisibility = true;
    const detached = await mountDetached("detached-tab-late-cleanup");
    const listener = [...eventBus.listeners].find((entry) => entry.event === ALWAYS_ON_TOP_TOOLBAR_VISIBILITY_CHANGED_EVENT)!;
    detached.unmount();
    listener.handler({ payload: true });
    expect(detached.store.editorSettings.toolbarItems.alwaysOnTop).toBe(false);
    eventBus.completeVisibility!();
    await vi.waitFor(() => expect(listener.unlisten).toHaveBeenCalledTimes(1));
    expect(eventBus.listeners.size).toBe(0);
  });

  it("handles listener registration failure without breaking the header", async () => {
    eventBus.registrationError = new Error("listener unavailable");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const detached = await mountDetached("detached-tab-listen-failure");
    expect(pinButton(detached.host)).toBeNull();
    expect(log).toHaveBeenCalledWith("[DBX][window:always-on-top-toolbar-visibility-listen]", eventBus.registrationError);
  });

  it("saves queued pre-initialization changes and publishes only after initialization", async () => {
    const detached = await mountDetached("detached-tab-startup");
    const { store: main } = createStore();
    main.updateEditorSettings(toolbarPatch(main, true));
    expect(emit).not.toHaveBeenCalled();
    await main.initEditorSettings();
    await vi.waitFor(() => expect(detached.store.editorSettings.toolbarItems.alwaysOnTop).toBe(true));
    expect(emit).toHaveBeenCalledExactlyOnceWith(ALWAYS_ON_TOP_TOOLBAR_VISIBILITY_CHANGED_EVENT, true);
  });

  it("does not register or emit native events in the browser", async () => {
    runtime.desktop = false;
    const detached = await mountDetached("detached-tab-web");
    await detached.store.updateEditorSettingsAndPersist(toolbarPatch(detached.store, true));
    expect(persistedSettings.toolbarItems.alwaysOnTop).toBe(true);
    expect(listen).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
