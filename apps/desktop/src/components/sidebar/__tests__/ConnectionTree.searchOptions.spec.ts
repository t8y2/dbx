// @vitest-environment happy-dom
import { computed, createApp, h, nextTick, ref, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import { createI18n } from "vue-i18n";
import en from "@/i18n/locales/en";
import LightDropdown from "@/components/ui/LightDropdown.vue";
import { DEFAULT_EDITOR_SETTINGS, useSettingsStore } from "@/stores/settingsStore";
import { matchSidebarLabel } from "@/lib/sidebar/sidebarSearch";
import { compileConnectionTreeTestScript } from "./connectionTreeTestScript";

vi.mock("@/lib/backend/api", () => ({ loadEditorSettings: vi.fn(async () => DEFAULT_EDITOR_SETTINGS), saveEditorSettings: vi.fn(async () => {}) }));
const apps: App[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.body.replaceChildren();
});

const compiled = compileConnectionTreeTestScript(["searchMatchMode", "isConnectionListAlphabeticallySorted", "sidebarListOptionsLabel", "sidebarListOptionItems", "selectedSidebarListOptions", "hasCustomSidebarListOptions", "selectSidebarListOption"]);

async function mount() {
  const settingsStore = useSettingsStore(createPinia());
  await settingsStore.initEditorSettings();
  const i18n = createI18n({ legacy: false, locale: "en", messages: { en } });
  const regexMode = ref(false);
  const bindings = {
    computed,
    settingsStore,
    regexMode,
    t: i18n.global.t,
    connectionListSortMenuItems: ref([{ value: "manual", label: "Manual" }]),
    searchScopeOptions: ref([{ scope: "table", label: "Table" }]),
    selectedSearchScopes: ref([]),
    hasSearchScopeFilter: ref(false),
    updateConnectionListSortMode: vi.fn(),
    toggleSearchScope: vi.fn(),
    clearSearchScopeFilter: vi.fn(),
  };
  const state = new Function(...Object.keys(bindings), `${compiled}; return { sidebarListOptionItems, selectedSidebarListOptions, hasCustomSidebarListOptions, sidebarListOptionsLabel, selectSidebarListOption };`)(...Object.values(bindings));
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({
    render: () =>
      h(LightDropdown, {
        modelValue: "",
        items: state.sidebarListOptionItems.value,
        selectedValues: state.selectedSidebarListOptions.value,
        ariaLabel: state.sidebarListOptionsLabel.value,
        closeOnSelect: false,
        "onUpdate:modelValue": state.selectSidebarListOption,
      }),
  });
  app.use(i18n);
  app.mount(container);
  apps.push(app);
  container.querySelector("button")!.click();
  await nextTick();
  return { ...state, settingsStore, regexMode };
}

function option(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((el) => el.textContent?.trim() === text)!;
}

it("changes matching through the existing menu and reflects its saved state", async () => {
  const view = await mount();
  expect(option("Smart matching").getAttribute("aria-checked")).toBe("true");
  expect(option("Contains text").getAttribute("aria-checked")).toBe("false");
  expect(document.body.textContent).not.toContain("Edges");
  expect(matchSidebarLabel("1001", "101", { matchMode: view.settingsStore.editorSettings.sidebarSearchMatchMode })).not.toBeNull();
  option("Contains text").click();
  await nextTick();
  expect(view.settingsStore.editorSettings.sidebarSearchMatchMode).toBe("contains");
  expect(matchSidebarLabel("1001", "101", { matchMode: view.settingsStore.editorSettings.sidebarSearchMatchMode })).toBeNull();
  expect(option("Contains text").getAttribute("aria-checked")).toBe("true");
  expect(option("Smart matching").getAttribute("aria-checked")).toBe("false");
  expect(view.hasCustomSidebarListOptions.value).toBe(false);
  expect(view.sidebarListOptionsLabel.value).toBe(en.sidebar.listOptions);
  expect(document.querySelector('[role="menuitemcheckbox"]')?.textContent).toContain("Table");
});

it("lets regex override the preference without overwriting it", async () => {
  const view = await mount();
  option("Contains text").click();
  view.regexMode.value = true;
  await nextTick();
  expect(option("Contains text").disabled).toBe(true);
  expect(option("Smart matching").disabled).toBe(true);
  option("Smart matching").click();
  expect(view.settingsStore.editorSettings.sidebarSearchMatchMode).toBe("contains");
  view.regexMode.value = false;
  await nextTick();
  expect(option("Contains text").disabled).toBe(false);
  expect(option("Contains text").getAttribute("aria-checked")).toBe("true");
});

it("supports keyboard selection and restores focus when closing the merged menu", async () => {
  const view = await mount();
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Sort and filter"]')!;
  trigger.focus();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(document.activeElement).toBe(option("Smart matching"));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(document.activeElement).toBe(option("Contains text"));
  option("Contains text").click();
  await nextTick();
  expect(view.settingsStore.editorSettings.sidebarSearchMatchMode).toBe("contains");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await nextTick();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
