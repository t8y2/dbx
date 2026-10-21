// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, watch, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import dialogSource from "../EditorSettingsDialog.vue?raw";
import formatterSource from "../SqlFormatterSettingsPanel.vue?raw";
import McpAuthorizationTabs from "@/components/settings/McpAuthorizationTabs.vue";
import { findSettingsSearchHighlightTarget } from "@/lib/settings/settingsSearchHighlight";
import type { SettingsSearchEntry } from "@/lib/settings/settingsSearch";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const apps: App[] = [];
afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// Compile the real navigation functions; rendering only the relevant views avoids booting
// database services. Unexpected saves or other business calls fail as unresolved bindings.
function navigationHarness(initialCategory = "appearance") {
  const state = {
    activeSettingsTab: ref(initialCategory),
    syncMethodTab: ref("webdav"),
    mcpManagementTab: ref("access"),
    mcpTransportTab: ref("stdio"),
    mcpAuthorizationTab: ref("overrides"),
    formatterMode: ref("form"),
    shortcutSearchQuery: ref(""),
    aiConfigListMode: ref("list"),
    settingsSearchQuery: ref("query"),
    settingsSearchOpen: ref(true),
    settingsSearchActiveIndex: ref(0),
    settingsContentScrollRef: ref<HTMLElement | null>(null),
    highlightedSettingsSearchTargetId: ref(""),
  };
  const start = dialogSource.indexOf("function applySettingsSearchRoute(");
  const end = dialogSource.indexOf("function onSettingsSearchKeydown(", start);
  const watcherStart = dialogSource.indexOf("  const result = pendingSettingsSearchResult;", dialogSource.indexOf("watch(activeSettingsTab,"));
  const watcherEnd = dialogSource.indexOf("\n});", watcherStart);
  expect(start).toBeGreaterThan(0);
  expect(watcherStart).toBeGreaterThan(0);
  const code = ts.transpileModule(
    `
    let pendingSettingsSearchResult = null;
    let highlightedSettingsSearchElement = null;
    let settingsSearchHighlightTimer = null;
    let settingsSearchHighlightAnimationHandler = null;
    const settingsSearchHighlightClasses = ["settings-search-highlight-breathe"];
    function clearSettingsSearchHighlight() {
      highlightedSettingsSearchElement?.classList.remove(...settingsSearchHighlightClasses);
    }
    ${dialogSource.slice(start, end)}
    watch(activeSettingsTab, async () => { ${dialogSource.slice(watcherStart, watcherEnd)} });
    return { selectSettingsSearchResult };
  `,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
  const factory = new Function(...Object.keys(state), "nextTick", "watch", "findSettingsSearchHighlightTarget", code);
  const api = factory(...Object.values(state), nextTick, watch, findSettingsSearchHighlightTarget) as {
    selectSettingsSearchResult: (entry: SettingsSearchEntry) => Promise<void>;
  };
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp({
    setup() {
      return () =>
        h("div", { ref: state.settingsContentScrollRef }, [
          state.activeSettingsTab.value === "mcp"
            ? state.mcpManagementTab.value === "permissions"
              ? h(
                  McpAuthorizationTabs,
                  {
                    modelValue: state.mcpAuthorizationTab.value as "overrides",
                    "onUpdate:modelValue": (value: string) => {
                      state.mcpAuthorizationTab.value = value;
                    },
                  },
                  Object.fromEntries(["overrides", "connections", "databases", "capabilities"].map((id) => [id, () => h("p", `Empty ${id}`)])),
                )
              : h("section", { "data-settings-search-id": `mcp-${state.mcpTransportTab.value}` }, "Transport")
            : h("section", { "data-settings-search-id": state.activeSettingsTab.value === "data" ? "redis-key-templates" : "appearance-settings" }, "Settings"),
        ]);
    },
  });
  app.mount(root);
  apps.push(app);
  return { ...state, ...api, root };
}

function entry(category: SettingsSearchEntry["category"], targetId: string, route?: SettingsSearchEntry["route"]): SettingsSearchEntry {
  return { id: targetId, targetId, category, title: "Absent title uses stable group", description: "", categoryLabel: category, route };
}

async function flush() {
  await nextTick();
  await nextTick();
  await nextTick();
}

describe("settings search navigation", () => {
  it("scrolls keyboard selection into view past the former eight-result limit and wraps", async () => {
    const settingsSearchResults = ref(Array.from({ length: 12 }, (_, index) => entry("editor", `entry-${index}`)));
    const settingsSearchActiveIndex = ref(7);
    const settingsSearchOpen = ref(true);
    const selectSettingsSearchResult = vi.fn();
    const exitSettingsSearch = vi.fn();
    const start = dialogSource.indexOf("function onSettingsSearchKeydown(");
    const end = dialogSource.indexOf("async function resetSettingsContentScroll(", start);
    const code = ts.transpileModule(dialogSource.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const keydown = new Function("settingsSearchResults", "settingsSearchActiveIndex", "settingsSearchOpen", "selectSettingsSearchResult", "exitSettingsSearch", "nextTick", `${code}; return onSettingsSearchKeydown;`)(
      settingsSearchResults,
      settingsSearchActiveIndex,
      settingsSearchOpen,
      selectSettingsSearchResult,
      exitSettingsSearch,
      nextTick,
    );
    const host = document.createElement("div");
    document.body.append(host);
    for (const result of settingsSearchResults.value) {
      const button = document.createElement("button");
      button.id = `settings-search-result-${result.id}`;
      host.append(button);
    }
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    for (let index = 8; index < 12; index++) {
      keydown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      await nextTick();
      expect(settingsSearchActiveIndex.value).toBe(index);
      expect(scroll.mock.instances.at(-1)).toBe(host.children[index]);
      expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
    }
    keydown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await nextTick();
    expect(settingsSearchActiveIndex.value).toBe(0);
    keydown(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    await nextTick();
    expect(settingsSearchActiveIndex.value).toBe(11);
    keydown(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(selectSettingsSearchResult).toHaveBeenCalledWith(settingsSearchResults.value[11]);
  });

  it("reveals a cross-category MCP authorization tab, then another tab in the same category, even with no records", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const harness = navigationHarness();
    for (const tab of ["databases", "capabilities", "connections", "overrides"] as const) {
      await harness.selectSettingsSearchResult(entry("mcp", `mcp-${tab}`, { mcpManagementTab: "permissions", mcpAuthorizationTab: tab }));
      await flush();
      const panel = harness.root.querySelector(`[data-settings-search-id="mcp-${tab}"]`);
      expect(panel?.getAttribute("data-state")).toBe("active");
      expect(panel?.classList.contains("settings-search-highlight-breathe")).toBe(true);
      expect(harness.settingsSearchQuery.value).toBe("");
      expect(harness.settingsSearchOpen.value).toBe(false);
    }
    expect(scroll).toHaveBeenCalledTimes(4);
  });

  it("switches management and transport before revealing HTTP, and reaches Redis across categories", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const harness = navigationHarness("mcp");
    harness.mcpManagementTab.value = "permissions";
    await harness.selectSettingsSearchResult(entry("mcp", "mcp-http", { mcpManagementTab: "access", mcpTransportTab: "http" }));
    await flush();
    expect(harness.root.querySelector('[data-settings-search-id="mcp-http"]')?.classList.contains("settings-search-highlight-breathe")).toBe(true);
    await harness.selectSettingsSearchResult(entry("data", "redis-key-templates"));
    await flush();
    expect(harness.root.querySelector('[data-settings-search-id="redis-key-templates"]')?.classList.contains("settings-search-highlight-breathe")).toBe(true);
    expect(dialogSource).toContain('id="redis-key-templates" data-settings-search-id="redis-key-templates"');
  });

  it("changes only view refs for sync and formatter routes and wires their controlled child modes", async () => {
    const harness = navigationHarness();
    await harness.selectSettingsSearchResult(entry("formatter", "formatter-json", { formatterMode: "json", syncMethodTab: "snippet" }));
    await flush();
    expect(harness.formatterMode.value).toBe("json");
    expect(harness.syncMethodTab.value).toBe("snippet");
    expect(dialogSource).toContain('v-model:mode="formatterMode"');
    expect(dialogSource).toContain('<McpAuthorizationTabs v-model="mcpAuthorizationTab">');
    expect(formatterSource).toContain('data-settings-search-id="formatter-json"');
    expect(dialogSource).toContain("searchSettings(settingsSearchEntries.value, settingsSearchQuery.value, currentLocale(), Infinity)");
  });
});
