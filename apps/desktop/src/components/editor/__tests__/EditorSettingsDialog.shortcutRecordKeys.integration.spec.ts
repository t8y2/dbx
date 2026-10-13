// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { DEFAULT_EDITOR_SETTINGS } from "@/stores/settingsStore";

// #11787：快捷键页签的「键盘录入」。承重声明有两条：
//   1. 录入的组合键写进**现有搜索框**，因此过滤/冲突徽章/作用域分组全部沿用既有管线；
//   2. 录入态吞掉按键（preventDefault + 停止传播），不执行真实快捷键命令。
// 这里驱动真实控件，避免把「写进了某个 ref」当成行为证明。

const hoisted = vi.hoisted(() => ({ shortcuts: {} as Record<string, string> }));

vi.mock("vue-i18n", async () => {
  const { ref } = await import("vue");
  const locale = ref("en");
  // Interpolate params so count assertions can read them (real vue-i18n folds them
  // into the message text).
  const t = (key: string, params?: Record<string, unknown>) => {
    if (!params) return key;
    const suffix = Object.keys(params)
      .sort()
      .map((name) => `${name}=${String(params[name])}`)
      .join(" ");
    return suffix ? `${key} ${suffix}` : key;
  };
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
    Dialog: passthrough,
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

// ChangelogPanel fires a network fetch on mount (About tab); irrelevant here.
vi.mock("@/components/settings/ChangelogPanel.vue", async () => {
  const { defineComponent } = await import("vue");
  return { default: defineComponent({ setup: () => () => null }) };
});

// Back the store composable with a stub so the dialog boots without the Tauri backend,
// but read `shortcuts` through the hoisted object so each test can seed the
// configuration it wants before mounting.
vi.mock("@/stores/settingsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/settingsStore")>();
  const store = {
    settingsPageActive: false,
    editorSettings: {
      ...actual.DEFAULT_EDITOR_SETTINGS,
      get shortcuts() {
        return hoisted.shortcuts;
      },
    },
    desktopSettings: actual.DEFAULT_DESKTOP_SETTINGS,
    mcpGlobalPolicy: { configured: false, readOnly: false },
    aiConfigs: [],
    aiDefaultTemplatesByDbType: {},
    defaultAiMode: "ask",
    restoreLastConversation: false,
    initMcpGlobalPolicy: vi.fn(async () => undefined),
    updateMcpGlobalPolicy: vi.fn(async () => undefined),
    initAiConfigs: vi.fn(async () => undefined),
    initDesktopSettings: vi.fn(async () => undefined),
    updateEditorSettingsAndPersist: vi.fn(async () => undefined),
    updateEditorSettings: vi.fn(),
    persistEditorSettings: vi.fn(async () => undefined),
    updateDesktopSettings: vi.fn(async () => undefined),
    reloadAiConfigs: vi.fn(async () => undefined),
    removeTemplateFromDefaultAndLastUsed: vi.fn(),
    setDefaultTemplatesForDbType: vi.fn(),
    updateAiConfigItem: vi.fn(),
    createAiConfig: vi.fn(),
    deleteAiConfig: vi.fn(),
    setDefaultAiConfig: vi.fn(),
    setDefaultAiMode: vi.fn(),
    setRestoreLastConversation: vi.fn(),
  };
  return { ...actual, useSettingsStore: () => store };
});

import EditorSettingsDialog from "../EditorSettingsDialog.vue";

if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// The pill and the recorded text are both display strings, so pin the platform
// instead of branching on the host's: the expectations below are spelled for
// Windows/Linux ("Ctrl + K"), which is what CI and this machine run.
const platformDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "platform");
beforeAll(() => {
  Object.defineProperty(globalThis.navigator, "platform", { value: "Win32", configurable: true });
});
afterAll(() => {
  if (platformDescriptor) Object.defineProperty(globalThis.navigator, "platform", platformDescriptor);
});

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

async function flushAsyncUpdates() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function defaults() {
  return { ...DEFAULT_EDITOR_SETTINGS.shortcuts };
}

async function mountShortcutsTab() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(defineComponent({ setup: () => () => h(EditorSettingsDialog, { variant: "page", initialTab: "shortcuts" }) }));
  app.use(createPinia());
  app.mount(host);
  mountedApps.push({ app, host });
  await flushAsyncUpdates();
  return host;
}

const shortcutsPane = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-settings-search-id="shortcuts"]')!;

const searchInput = (host: HTMLElement) => shortcutsPane(host).querySelector<HTMLInputElement>('input[placeholder="settings.shortcutSearchPlaceholder"]')!;

const recorderButton = (host: HTMLElement) => shortcutsPane(host).querySelector<HTMLButtonElement>('[data-shortcut-recorder], button[aria-label="settings.shortcutRecordKeys"]')!;

const rows = (host: HTMLElement) => [...shortcutsPane(host).querySelectorAll<HTMLElement>(".settings-shortcut-row")];

const visibleRowIds = (host: HTMLElement) => rows(host).map((row) => row.querySelector<HTMLInputElement>("input[data-shortcut-input]")!.dataset.shortcutInput!);

function pressKeys(target: HTMLElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("EditorSettingsDialog shortcut key recording (behaviour)", () => {
  it("records a pressed combination into the search box and filters the list to it", async () => {
    hoisted.shortcuts = defaults();
    const host = await mountShortcutsTab();
    const button = recorderButton(host);
    const search = searchInput(host);

    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(shortcutsPane(host).textContent).not.toContain("settings.shortcutRecordKeysRecordingHint");

    button.click();
    await flushAsyncUpdates();

    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("data-shortcut-recorder")).toBe("active");
    expect(shortcutsPane(host).textContent).toContain("settings.shortcutRecordKeysRecordingHint");

    pressKeys(button, { key: "k", ctrlKey: true, shiftKey: true });
    await flushAsyncUpdates();

    // deleteLine is the only action bound to Shift+Mod+K in the defaults.
    expect(search.value).toBe("Ctrl + Shift + K");
    expect(visibleRowIds(host)).toEqual(["deleteLine"]);
  });

  it("finds every action sharing the combination, and reports their conflict", async () => {
    // The reported pain point (#11787) is hunting conflicts: the same chord on two
    // actions must both show up once the chord is recorded.
    hoisted.shortcuts = { ...defaults(), find: "Ctrl+Shift+K" };
    const host = await mountShortcutsTab();

    recorderButton(host).click();
    await flushAsyncUpdates();
    pressKeys(recorderButton(host), { key: "k", ctrlKey: true, shiftKey: true });
    await flushAsyncUpdates();

    const ids = visibleRowIds(host);
    expect(ids).toContain("deleteLine");
    expect(ids).toContain("find");
    // Conflict badges / group counts follow the same search pipeline, so the
    // duplicate is reported without any extra wiring.
    expect(shortcutsPane(host).textContent).toContain("settings.shortcutConflictBadge");
  });

  it("swallows the pressed combination instead of running it", async () => {
    hoisted.shortcuts = defaults();
    const host = await mountShortcutsTab();
    const button = recorderButton(host);
    button.click();
    await flushAsyncUpdates();

    // App.vue's global handler returns early on `defaultPrevented`; a combination that
    // would otherwise close the tab must not reach anything outside the recorder.
    let reachedDocument = false;
    const listener = () => {
      reachedDocument = true;
    };
    document.addEventListener("keydown", listener);
    const event = pressKeys(button, { key: "w", ctrlKey: true });
    document.removeEventListener("keydown", listener);

    expect(event.defaultPrevented).toBe(true);
    expect(reachedDocument).toBe(false);
  });

  it("keeps waiting while only a modifier is held, then exits on Esc and clears on Backspace", async () => {
    hoisted.shortcuts = defaults();
    const host = await mountShortcutsTab();
    const button = recorderButton(host);
    const search = searchInput(host);
    button.click();
    await flushAsyncUpdates();

    pressKeys(button, { key: "Control", ctrlKey: true });
    await flushAsyncUpdates();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(search.value).toBe("");

    pressKeys(button, { key: "k", ctrlKey: true, shiftKey: true });
    await flushAsyncUpdates();
    expect(search.value).toBe("Ctrl + Shift + K");

    // Esc leaves recording but keeps what was recorded, so the filtered list stays.
    pressKeys(button, { key: "Escape" });
    await flushAsyncUpdates();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.hasAttribute("data-shortcut-recorder")).toBe(false);
    expect(search.value).toBe("Ctrl + Shift + K");
    expect(visibleRowIds(host)).toEqual(["deleteLine"]);

    button.click();
    await flushAsyncUpdates();
    pressKeys(button, { key: "Backspace" });
    await flushAsyncUpdates();
    expect(search.value).toBe("");
    expect(visibleRowIds(host).length).toBeGreaterThan(1);
  });

  it("shows the empty state for a combination nothing is bound to", async () => {
    hoisted.shortcuts = defaults();
    const host = await mountShortcutsTab();

    recorderButton(host).click();
    await flushAsyncUpdates();
    pressKeys(recorderButton(host), { key: "u", ctrlKey: true, altKey: true, shiftKey: true });
    await flushAsyncUpdates();

    // Modifier order comes from the shared display formatter (Shift before Alt), so the
    // recorded text is spelled exactly like a pill would be.
    expect(searchInput(host).value).toBe("Ctrl + Shift + Alt + U");
    expect(rows(host).length).toBe(0);
    expect(shortcutsPane(host).textContent).toContain("settings.shortcutSearchNoResults");
  });

  it("leaves recording when focus leaves the recorder button", async () => {
    hoisted.shortcuts = defaults();
    const host = await mountShortcutsTab();
    const button = recorderButton(host);
    button.click();
    await flushAsyncUpdates();
    expect(button.getAttribute("aria-pressed")).toBe("true");

    // 焦点离开（用户去点了搜索框/某一行）后 keydown 不再到达按钮：必须退出录入态，
    // 否则会留下一个看不见的空转状态。
    button.dispatchEvent(new FocusEvent("blur"));
    await flushAsyncUpdates();

    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.hasAttribute("data-shortcut-recorder")).toBe(false);
    expect(shortcutsPane(host).textContent).not.toContain("settings.shortcutRecordKeysRecordingHint");
  });

  it("records keys that would otherwise activate the button itself", async () => {
    hoisted.shortcuts = defaults();
    const host = await mountShortcutsTab();
    const button = recorderButton(host);
    button.click();
    await flushAsyncUpdates();

    // Space/Enter 是按钮的默认激活键：录入态必须吞掉它们，不能把自己点掉。
    const space = pressKeys(button, { key: " " });
    await flushAsyncUpdates();
    expect(space.defaultPrevented).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(searchInput(host).value).toBe("Space");

    const enter = pressKeys(button, { key: "Enter" });
    await flushAsyncUpdates();
    expect(enter.defaultPrevented).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(searchInput(host).value).toBe("↵");
  });

  it("leaves plain text search untouched after recording", async () => {
    hoisted.shortcuts = defaults();
    const host = await mountShortcutsTab();
    const button = recorderButton(host);
    button.click();
    await flushAsyncUpdates();
    pressKeys(button, { key: "k", ctrlKey: true, shiftKey: true });
    await flushAsyncUpdates();
    pressKeys(button, { key: "Escape" });
    await flushAsyncUpdates();

    const search = searchInput(host);
    search.value = "shortcutFormatSql";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await flushAsyncUpdates();

    expect(visibleRowIds(host)).toEqual(["formatSql"]);
  });
});
