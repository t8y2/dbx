// @vitest-environment happy-dom
import * as Vue from "vue";
import { createApp, defineComponent, nextTick, ref, type App, type RenderFunction } from "vue";
import { compileTemplate } from "vue/compiler-sfc";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { Input } from "@/components/ui/input";
import dialogSource from "../EditorSettingsDialog.vue?raw";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

// Slice the real global settings search input out of the dialog template and
// render it with the production Input component. This pins the input's type:
// it must be a search field, not a plain text field, so browsers do not offer
// form-history / credential autofill for it (issue #14946 — the Settings >
// Security search box kept refilling from browser history even after clearing,
// while every other search box in the app is type="search" and does not).
const marker = dialogSource.indexOf("data-settings-global-search");
if (marker < 0) throw new Error("Could not find the global settings search input in EditorSettingsDialog.vue");
const inputStart = dialogSource.lastIndexOf("<Input", marker);
const inputEnd = dialogSource.indexOf("/>", marker);
if (inputStart < 0 || inputEnd < 0) throw new Error("Could not slice the global settings search input");
const compiledSearchInput = compileTemplate({
  source: dialogSource.slice(inputStart, inputEnd + "/>".length),
  filename: "EditorSettingsDialog.vue",
  id: "settings-search-input",
});
if (compiledSearchInput.errors.length) throw new Error(`Could not compile the settings search input: ${compiledSearchInput.errors.join("; ")}`);
const searchInputExports = {} as { render: RenderFunction };
new Function("require", "exports", ts.transpileModule(compiledSearchInput.code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)((name: string) => {
  if (name === "vue") return Vue;
  throw new Error(`Unexpected template dependency: ${name}`);
}, searchInputExports);

const apps: App[] = [];
afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mountSearchInput() {
  const settingsSearchQuery = ref("");
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(
    defineComponent({
      components: { Input },
      setup: () => ({
        settingsSearchQuery,
        settingsSearchOpen: ref(false),
        settingsSearchVisible: ref(false),
        settingsSearchResults: ref([]),
        settingsSearchActiveIndex: ref(0),
        t: (key: string) => key,
        onSettingsSearchKeydown: vi.fn(),
      }),
      render: searchInputExports.render,
    }),
  );
  app.mount(root);
  apps.push(app);
  return { root, settingsSearchQuery };
}

describe("settings search input", () => {
  it("is a search field so the browser does not autofill it from history (#14946)", async () => {
    const { root } = mountSearchInput();
    await nextTick();
    const input = root.querySelector<HTMLInputElement>("[data-settings-global-search]");
    expect(input).not.toBeNull();
    // Browsers offer form-history / credential autofill for type="text"
    // inputs but not for type="search" ones; every other search box in the
    // app already uses type="search".
    expect(input?.getAttribute("type")).toBe("search");
    expect(input?.getAttribute("autocomplete")).toBe("off");
  });
});
