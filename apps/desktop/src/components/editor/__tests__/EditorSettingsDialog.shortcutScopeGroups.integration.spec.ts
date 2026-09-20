// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { DEFAULT_EDITOR_SETTINGS } from "@/stores/settingsStore";
import { SHORTCUT_DEFINITIONS } from "@/lib/editor/shortcutRegistry";

// Behaviour proof for the scope-grouping / two-tier conflict work, on top of the
// source-contract spec (EditorSettingsDialog.shortcutScopeGroups.spec.ts). The
// load-bearing claim is the tier split:
//   · L1 same-scope duplicate -> blocking (red pill, footer reason, Apply gate)
//   · L2 cross-scope overlap  -> informational only (amber pill, never blocking)
// The source spec pins the wiring; this one drives the real rendered controls so
// a wrong tier can't hide behind a passing string assertion.

const hoisted = vi.hoisted(() => ({ shortcuts: {} as Record<string, string> }));

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

// Back the store composable with a stub so the dialog boots without the Tauri
// backend, but read `shortcuts` through the hoisted object so each test can seed
// the configuration it wants before mounting.
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

// Scope groups are the only sections whose own header carries an h3 title; the
// pane also hosts the SQL-shortcuts block, which must not join the group list.
const groupSections = (host: HTMLElement) => [...shortcutsPane(host).querySelectorAll<HTMLElement>("section")].filter((section) => [...section.children].some((child) => child.tagName === "HEADER"));

const groupLabels = (host: HTMLElement) => groupSections(host).map((section) => section.querySelector("h3")!.textContent!.trim());

const rows = (host: HTMLElement) => [...shortcutsPane(host).querySelectorAll<HTMLElement>(".settings-shortcut-row")];

const inputFor = (host: HTMLElement, id: string) => shortcutsPane(host).querySelector<HTMLInputElement>(`input[data-shortcut-input="${id}"]`)!;

const rowFor = (host: HTMLElement, id: string) => inputFor(host, id).closest<HTMLElement>(".settings-shortcut-row")!;

function button(host: HTMLElement, text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text) ?? null;
}

const applyButton = (host: HTMLElement) => button(host, "settings.apply")!;

// Turn a stored shortcut string ("Ctrl+Shift+F" / "Shift+Mod+F") into the keydown
// a real capture input would receive, resolving `Mod` for the host platform.
function shortcutKeyEvent(shortcut: string): KeyboardEvent {
  const parts = shortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop() ?? "";
  const isMac = /mac/i.test(globalThis.navigator?.platform ?? "");
  const init: KeyboardEventInit = { key: key.length === 1 ? key.toLowerCase() : key, bubbles: true };
  for (const part of parts) {
    if (/^(ctrl|control)$/i.test(part)) init.ctrlKey = true;
    else if (/^shift$/i.test(part)) init.shiftKey = true;
    else if (/^(alt|option)$/i.test(part)) init.altKey = true;
    else if (/^meta$/i.test(part)) init.metaKey = true;
    else if (/^mod$/i.test(part)) {
      if (isMac) init.metaKey = true;
      else init.ctrlKey = true;
    }
  }
  return new KeyboardEvent("keydown", init);
}

// The footer keeps a standing explanation of a blocked Apply now that the row
// no longer carries inline conflict text.
const hasFooterBlockerReason = (host: HTMLElement) => (host.textContent ?? "").includes("settings.shortcutConflictBlocksApply");

describe("EditorSettingsDialog shortcut scope grouping (behaviour)", () => {
  it("renders one group per scope in runtime dispatch order, without repeating the scope on rows", async () => {
    hoisted.shortcuts = defaults();
    const host = await mountShortcutsTab();

    expect(groupLabels(host)).toEqual(["settings.shortcutScopeGlobal", "settings.shortcutScopeEditor", "settings.shortcutScopeGrid", "settings.shortcutScopeSearch", "settings.shortcutScopeSidebar"]);

    // Scope moved into the group header — rows must not repeat it.
    const rendered = rows(host);
    expect(rendered.length).toBeGreaterThan(0);
    for (const row of rendered) {
      expect(row.textContent).not.toContain("settings.shortcutScope");
    }
  });

  it("treats a same-scope duplicate as blocking: red pills, footer reason and a disabled Apply", async () => {
    const base = defaults();
    hoisted.shortcuts = base;
    const host = await mountShortcutsTab();

    // Pristine draft: nothing to block yet.
    expect(hasFooterBlockerReason(host)).toBe(false);

    // explainSql and formatSql both live in the editor scope. Capture the chord
    // formatSql already owns through the real capture input.
    rowFor(host, "explainSql").querySelector<HTMLButtonElement>("button")!.click();
    await flushAsyncUpdates();
    inputFor(host, "explainSql").dispatchEvent(shortcutKeyEvent(base.formatSql));
    await flushAsyncUpdates();

    expect(inputFor(host, "explainSql").getAttribute("aria-invalid")).toBe("true");
    expect(inputFor(host, "formatSql").getAttribute("aria-invalid")).toBe("true");
    expect(rowFor(host, "formatSql").dataset.conflict).toBe("true");
    expect(rowFor(host, "explainSql").dataset.conflict).toBe("true");
    // The row no longer carries inline text, so the footer has to explain why
    // Apply is unavailable.
    expect(hasFooterBlockerReason(host)).toBe(true);
    expect(applyButton(host).disabled).toBe(true);
  });

  it("keeps a cross-scope overlap informational: amber tier renders, Apply stays reachable", async () => {
    hoisted.shortcuts = defaults();
    const host = await mountShortcutsTab();

    // `find` (editor) and `focusSearch` (global) share Mod+F by design.
    const crossScopeRows = shortcutsPane(host).querySelectorAll('.settings-shortcut-row[data-cross-scope="true"]');
    expect(crossScopeRows.length).toBeGreaterThan(0);
    expect(shortcutsPane(host).querySelectorAll('.settings-shortcut-row[data-conflict="true"]').length).toBe(0);
    expect(hasFooterBlockerReason(host)).toBe(false);

    // Drive a real rebind through the rendered controls (capture state + keydown):
    // any change makes Apply reachable, and a chord that collides with no other
    // action in the same scope must NOT be blocked by the cross-scope tier.
    const taken = new Set(Object.values(defaults()));
    const candidate = ["Ctrl+Alt+Shift+1", "Ctrl+Alt+Shift+2", "Ctrl+Alt+Shift+3"].find((key) => !taken.has(key))!;

    const row = rowFor(host, "executeSql");
    row.querySelector<HTMLButtonElement>("button")!.click();
    await flushAsyncUpdates();

    const capture = inputFor(host, "executeSql");
    expect(capture.value).toBe("");
    capture.dispatchEvent(new KeyboardEvent("keydown", { key: candidate.slice(-1), ctrlKey: true, altKey: true, shiftKey: true, bubbles: true }));
    await flushAsyncUpdates();

    expect(inputFor(host, "executeSql").value).not.toBe("");
    expect(shortcutsPane(host).querySelectorAll('.settings-shortcut-row[data-conflict="true"]').length).toBe(0);
    expect(hasFooterBlockerReason(host)).toBe(false);
    expect(applyButton(host).disabled).toBe(false);
  });

  it("drops groups that have no row left after a search, so header counts cannot disagree", async () => {
    hoisted.shortcuts = defaults();
    const host = await mountShortcutsTab();

    const search = shortcutsPane(host).querySelector<HTMLInputElement>('input[placeholder="settings.shortcutSearchPlaceholder"]')!;
    search.value = "shortcutFormatSql";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await flushAsyncUpdates();

    const sections = groupSections(host);
    expect(sections.length).toBe(1);
    expect(sections[0].querySelectorAll(".settings-shortcut-row").length).toBe(1);
    expect(groupLabels(host)).toEqual(["settings.shortcutScopeEditor"]);
  });

  it("keeps the scope order aligned with the registry scopes", async () => {
    hoisted.shortcuts = defaults();
    const host = await mountShortcutsTab();

    const scopes = new Set(SHORTCUT_DEFINITIONS.map((definition) => definition.scope));
    const rendered = groupLabels(host).map((label) => {
      const raw = label.replace("settings.shortcutScope", "");
      return raw.charAt(0).toLowerCase() + raw.slice(1);
    });

    // Only scopes that actually have actions render, but whatever renders must be
    // a sub-sequence of the dispatch order (global -> editor -> grid -> search -> sidebar).
    const dispatchOrder = ["global", "editor", "grid", "search", "sidebar"];
    for (const scope of rendered) expect(scopes).toContain(scope);
    const positions = rendered.map((scope) => dispatchOrder.indexOf(scope));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((index) => index >= 0)).toBe(true);
  });
});
