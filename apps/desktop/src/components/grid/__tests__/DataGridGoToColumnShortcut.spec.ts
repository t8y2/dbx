// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, defineComponent, h, markRaw, nextTick, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/composables/useDataGridColumnResize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDataGridColumnResize")>();
  const { ref } = await import("vue");
  return {
    ...actual,
    useDataGridColumnResize: () => ({
      initColumnWidths: vi.fn(),
      onResizeStart: vi.fn(),
      autoFitColumn: vi.fn(),
      renderedColumnWidths: ref([120]),
      totalWidth: ref(120),
      columnVars: ref({ "--total-w": "120px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const dataGridSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGrid.vue"), "utf8");
const appSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/App.vue"), "utf8");
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

const RecycleScroller = defineComponent({
  props: {
    items: {
      type: Array as PropType<unknown[]>,
      default: () => [],
    },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        "div",
        attrs,
        props.items.map((item) => slots.default?.({ item })),
      );
  },
});

function mountGrid(options: { displayableColumns?: boolean; columns?: string[] } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    shortcuts: {
      ...settingsStore.editorSettings.shortcuts,
      goToColumn: "Mod+G",
    },
  });
  const result = markRaw<QueryResult>({
    columns: options.columns ?? ["id"],
    rows: [Array.from({ length: (options.columns ?? ["id"]).length }, (_, index) => index + 1)],
    affected_rows: 0,
    execution_time_ms: 0,
    hidden_column_indexes: options.displayableColumns === false ? [0] : undefined,
  });

  const host = document.createElement("div");
  document.body.append(host);
  const Root = defineComponent({
    setup() {
      return () =>
        h(
          TooltipProvider,
          { delayDuration: 0 },
          {
            default: () =>
              h(DataGrid, {
                result,
                databaseType: "mysql",
                context: "table-data",
              }),
          },
        );
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.component("RecycleScroller", RecycleScroller);
  app.mount(host);
  const mounted = { app, host };
  mountedApps.push(mounted);
  return mounted;
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function gridRoot(host: HTMLElement): HTMLElement {
  const root = host.querySelector<HTMLElement>("[data-grid-root]");
  if (!root) throw new Error("Data grid root not found");
  return root;
}

function goToColumnButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === "Go to column");
  if (!button) throw new Error("Go-to-column button not found");
  return button;
}

function goToColumnItem(name: string, position: number): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.replaceAll(/\s/g, "") === `${name}#${position}`);
  if (!button) throw new Error(`Go-to-column item ${name} not found`);
  return button;
}

function goToColumnEvent(target: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "g" });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

function functionBody(name: string, nextName: string): string {
  const start = dataGridSource.indexOf(`function ${name}`);
  const end = dataGridSource.indexOf(`function ${nextName}`, start + 1);
  return start >= 0 && end > start ? dataGridSource.slice(start, end) : "";
}

describe("DataGrid go-to-column shortcut", () => {
  it("opens and consumes the configured shortcut when a column is displayable", async () => {
    const { host } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    root.focus();
    expect(document.activeElement).toBe(root);

    const event = goToColumnEvent(root);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(goToColumnButton(host).getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.getAttribute("placeholder")).toBe("Search column/comment...");
  });

  it("moves the lookup selection with arrows and chooses it with Enter", async () => {
    const { host } = mountGrid({ columns: ["id", "name"] });
    await settle();
    const root = gridRoot(host);
    root.focus();
    goToColumnEvent(root);
    await settle();

    const input = document.activeElement as HTMLInputElement;
    const down = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" });
    input.dispatchEvent(down);
    await settle();

    expect(down.defaultPrevented).toBe(true);
    expect(goToColumnItem("name", 2).classList).toContain("bg-accent");

    const enter = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });
    input.dispatchEvent(enter);
    await settle();

    expect(enter.defaultPrevented).toBe(true);
    expect(goToColumnButton(host).getAttribute("aria-expanded")).toBe("false");
  });

  it("does not consume the configured shortcut without a displayable column", async () => {
    const { host } = mountGrid({ displayableColumns: false });
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const event = goToColumnEvent(root);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(goToColumnButton(host).getAttribute("aria-expanded")).toBe("false");
  });

  it("does not trigger or consume shortcuts from editable targets", async () => {
    const { host } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    const targets = [document.createElement("input"), document.createElement("textarea"), document.createElement("div"), document.createElement("div")];
    targets[2]!.setAttribute("contenteditable", "true");
    targets[3]!.setAttribute("role", "textbox");

    for (const target of targets) {
      root.append(target);
      const event = goToColumnEvent(target);
      expect(event.defaultPrevented).toBe(false);
    }
    await settle();

    expect(bubbled).toHaveBeenCalledTimes(targets.length);
    expect(goToColumnButton(host).getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves an unmatched root event untouched", async () => {
    const { host } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "j" });

    root.dispatchEvent(event);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(goToColumnButton(host).getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the existing popover through the shared grid action", () => {
    const keydown = functionBody("onGridKeydown", "copyDetailValue");

    expect(dataGridSource).toMatch(/<div\b(?=[^>]*\bdata-grid-root)(?=[^>]*\btabindex="0")(?=[^>]*@keydown="onGridKeydown")[^>]*>/);
    expect(keydown).toMatch(
      /const targetAllowsNativeClipboard = eventTargetAllowsNativeClipboard\(event\);[\s\S]*?if \(!targetAllowsNativeClipboard && isGoToColumnShortcut\(event, settingsStore\.editorSettings\.shortcuts\) && openGoToColumn\(\)\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);[\s\S]*?return;[\s\S]*?\}/,
    );
    expect(dataGridSource).toContain("function openGoToColumn(): boolean");
    expect(dataGridSource).toContain("if (!displayableColumnIndexes.value.length) return false;");
  });

  it("keeps editable targets available for the application-level fallback", () => {
    const keydown = functionBody("onGridKeydown", "copyDetailValue");
    const shortcutStart = keydown.indexOf("if (!targetAllowsNativeClipboard && isGoToColumnShortcut");
    const shortcutEnd = keydown.indexOf("if (isFocusSearchShortcut", shortcutStart);
    const shortcutBranch = keydown.slice(shortcutStart, shortcutEnd);

    expect(shortcutStart).toBeGreaterThan(-1);
    expect(shortcutBranch).not.toContain("else");
    expect(shortcutBranch.match(/preventDefault/g)).toHaveLength(1);
    expect(shortcutBranch.match(/stopPropagation/g)).toHaveLength(1);
  });

  it("gives the data-tab fallback priority over conflicting global shortcuts", () => {
    const keydown = functionBody("onGridKeydown", "copyDetailValue");

    expect(keydown).toMatch(/if \(isFocusSearchShortcut\(event\) && !isGoToColumnShortcut\(event, settingsStore\.editorSettings\.shortcuts\)\)/);
    expect(appSource).toMatch(
      /const shortcuts = settingsStore\.editorSettings\.shortcuts;[\s\S]*?if \(showTabSwitcher\.value\) return;[\s\S]*?if \(isGoToColumnShortcut\(e, shortcuts\) && contentAreaRef\.value\?\.openGoToColumn\(\)\) \{[\s\S]*?return;[\s\S]*?const tabSwitcherDirection = tabSwitcherDirectionFromShortcut\(e, shortcuts\);/,
    );
  });

  it("keeps toolbar navigation and adds keyboard selection to the lookup", () => {
    const selectColumn = functionBody("scrollToColumn", "onGoToColumnKeydown");
    const escape = functionBody("onGoToColumnKeydown", "matchesTableInfoColumn");
    const scroll = functionBody("scrollToColumnIndex", "measureColumnHeaderText");

    expect(dataGridSource.match(/<Popover v-model:open="goToColumnOpen">/g)).toHaveLength(1);
    expect(dataGridSource).toContain('>{{ t("grid.goToColumn") }}</span');
    expect(dataGridSource).toContain('v-model="goToColumnSearch"');
    expect(dataGridSource).toContain('ref="goToColumnSearchInput"');
    expect(dataGridSource).toContain('ref="goToColumnListRef"');
    expect(dataGridSource).toContain("filterDataGridColumnLookupItems(goToColumnItems.value, goToColumnSearch.value)");
    expect(dataGridSource).toContain("const goToColumnSelectedIndex = ref(0);");
    expect(selectColumn).toContain('goToColumnSearch.value = ""');
    expect(selectColumn).toContain("scrollToColumnIndex(columnIndex)");
    expect(escape).toMatch(/event\.key === "ArrowDown"[\s\S]*?moveGoToColumnSelection\(1\)/);
    expect(escape).toMatch(/event\.key === "ArrowUp"[\s\S]*?moveGoToColumnSelection\(-1\)/);
    expect(escape).toMatch(/event\.key === "Enter"[\s\S]*?scrollToColumn\(selected\.index\)/);
    expect(escape).toMatch(/event\.key === "Escape"[\s\S]*?goToColumnOpen\.value = false;[\s\S]*?goToColumnSearch\.value = ""/);
    expect(scroll).toContain("if (hiddenColumnIndexes.value.has(columnIndex))");
    expect(scroll).toContain("showColumn(columnIndex)");
    expect(scroll).toContain("highlightedColumnIndex.value = columnIndex");
    expect(scroll).toContain("scroller.scrollLeft = targetLeft");
    expect(scroll).toContain("updateGridHorizontalViewport(scroller)");
  });
});
