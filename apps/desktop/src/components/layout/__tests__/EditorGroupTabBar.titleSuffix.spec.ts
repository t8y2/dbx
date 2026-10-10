// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/CustomContextMenu.vue", () => ({
  default: {
    name: "CustomContextMenuStub",
    props: ["items"],
    template: `<div class="ctx-menu-stub"><button v-for="(item, index) in items.filter((entry) => entry.visible !== false && !entry.separator)" :key="index" type="button" class="ctx-item" @click="item.action && item.action()">{{ item.label }}</button><slot /></div>`,
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: { name: "TooltipStub", template: `<div><slot /></div>` },
  TooltipTrigger: { name: "TooltipTriggerStub", template: `<div><slot /></div>` },
  TooltipContent: { name: "TooltipContentStub", template: `<div><slot /></div>` },
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: { name: "PopoverStub", props: ["open"], template: `<div v-if="open"><slot /></div>` },
  PopoverContent: { name: "PopoverContentStub", template: `<div><slot /></div>` },
  PopoverTrigger: { name: "PopoverTriggerStub", template: `<div><slot /></div>` },
}));

vi.mock("@/components/connection/ReadOnlySessionControl.vue", () => ({
  default: { name: "ReadOnlySessionControlStub", template: `<span />` },
}));

vi.mock("@/components/layout/TabExecutionStatus.vue", () => ({
  default: { name: "TabExecutionStatusStub", template: `<span><slot /></span>` },
}));

vi.mock("@/components/icons/DatabaseIcon.vue", () => ({
  default: { name: "DatabaseIconStub", template: `<span />` },
}));

import EditorGroupTabBar from "../EditorGroupTabBar.vue";
import { useQueryStore } from "@/stores/queryStore";
import { TAB_TITLE_SUFFIX_MAX_LENGTH } from "@/lib/tabs/tabPresentation";

function mountBar(groupId: string, tabIds: string[], activeTabId: string, pinia: ReturnType<typeof createPinia>) {
  const store = useQueryStore();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(EditorGroupTabBar, {
    groupId,
    tabs: tabIds.map((id) => store.tabs.find((tab) => tab.id === id)!),
    activeTabId,
  });
  app.use(pinia);
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          common: { cancel: "Cancel", save: "Save", close: "Close" },
          connectionGroup: { ungroupedLabel: "Ungrouped" },
          contextMenu: { setTabSuffix: "Set suffix", clearTabSuffix: "Clear suffix", renameTab: "Rename", duplicateTab: "Duplicate", copyName: "Copy name", closeTab: "Close" },
          sidebar: { locateActiveTab: "Locate" },
          tabs: {
            suffixDialogTitle: "Set tab suffix",
            suffixLabel: "Suffix",
            suffixPlaceholder: "e.g. pending",
            suffixHint: "hint",
            suffixMaxLength: "Maximum {max} characters.",
            suffixDuplicateTitle: "Duplicate suffix",
            suffixDuplicateMessage: 'Another tab is already shown as "{title}".',
            suffixDuplicateBack: "Change suffix",
            suffixDuplicateUseAnyway: "Use anyway",
          },
        },
      },
    }),
  );
  app.mount(host);
  return { app, host };
}

async function settle() {
  await nextTick();
  await nextTick();
  await nextTick();
}

function menuButtons(host: HTMLElement, tabId: string): HTMLButtonElement[] {
  const stub = host.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)!.closest<HTMLElement>(".ctx-menu-stub")!;
  return Array.from(stub.querySelectorAll<HTMLButtonElement>(":scope > button.ctx-item"));
}

function menuLabels(host: HTMLElement, tabId: string): string[] {
  return menuButtons(host, tabId).map((button) => button.textContent ?? "");
}

function pill(host: HTMLElement, tabId: string): HTMLElement {
  return host.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)!;
}

/** Opens the suffix editor through the real "Set suffix" menu entry. */
async function openSuffixEditor(host: HTMLElement, tabId: string) {
  menuButtons(host, tabId)
    .find((button) => button.textContent === "Set suffix")!
    .click();
  await settle();
}

function byAttr<T extends HTMLElement>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

async function typeSuffix(value: string) {
  const input = byAttr<HTMLInputElement>("[data-tab-suffix-input]")!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

describe("EditorGroupTabBar tab title suffix", () => {
  let pinia: ReturnType<typeof createPinia>;

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    pinia = createPinia();
    setActivePinia(pinia);
  });

  function openTwoDataTabs() {
    const store = useQueryStore();
    const first = store.createTab("pg-1", "app", "users", "data", "public", undefined, undefined, { forceNew: true });
    const second = store.createTab("pg-1", "app", "users", "data", "public", undefined, undefined, { forceNew: true });
    return { store, first, second };
  }

  it("offers the suffix action on every non-query tab, and the clear action only once a suffix exists", async () => {
    const { store, first } = openTwoDataTabs();
    const queryId = store.createTab("pg-1", "app", "Query 1", "query");
    const { app, host } = mountBar(store.groups[0].id, [first, queryId], first, pinia);
    await settle();

    expect(menuLabels(host, first)).toContain("Set suffix");
    expect(menuLabels(host, first)).not.toContain("Clear suffix");
    expect(menuLabels(host, queryId)).not.toContain("Set suffix");

    store.setTabTitleSuffix(first, "待办");
    await settle();
    expect(menuLabels(host, first)).toContain("Clear suffix");

    app.unmount();
    host.remove();
  });

  // Two tabs on the same target, per kind of tab the reporter listed: SQL data
  // tabs (mysql / postgres / sqlserver), mongodb, redis and plugin pages.
  const duplicateTabKinds: Array<{ name: string; /** false when the store already gives the two tabs different titles. */ collides: boolean; open: (store: ReturnType<typeof useQueryStore>) => [string, string] }> = [
    {
      name: "table data (mysql / postgres / sqlserver)",
      collides: true,
      open: (store) => [store.createTab("pg-1", "app", "users", "data", "public", undefined, undefined, { forceNew: true }), store.createTab("pg-1", "app", "users", "data", "public", undefined, undefined, { forceNew: true })],
    },
    {
      name: "mongodb collection",
      collides: true,
      open: (store) => [store.createTab("mongo-1", "app", "orders", "mongo", undefined, undefined, undefined, { forceNew: true }), store.createTab("mongo-1", "app", "orders", "mongo", undefined, undefined, undefined, { forceNew: true })],
    },
    {
      name: "redis database",
      collides: true,
      open: (store) => [store.createTab("redis-1", "0", "Redis 0", "redis", undefined, undefined, undefined, { forceNew: true }), store.createTab("redis-1", "0", "Redis 0", "redis", undefined, undefined, undefined, { forceNew: true })],
    },
    {
      name: "plugin workbench",
      // openPluginWorkbench numbers sibling sessions itself ("SSH server", "SSH server (1)").
      collides: false,
      open: (store) => [store.openPluginWorkbench("io.dbx.ssh", "io.dbx.ssh.workbench", { title: "SSH server", connectionId: "ssh-1", forceNew: true }), store.openPluginWorkbench("io.dbx.ssh", "io.dbx.ssh.workbench", { title: "SSH server", connectionId: "ssh-1", forceNew: true })],
    },
  ];

  it.each(duplicateTabKinds)("sets a custom suffix on a $name tab and only warns when the labels would really match", async ({ open, collides }) => {
    const store = useQueryStore();
    const [first, second] = open(store);
    expect(first).not.toBe(second);
    const { app, host } = mountBar(store.groups[0].id, [first, second], first, pinia);
    await settle();

    expect(menuLabels(host, second)).toContain("Set suffix");

    await openSuffixEditor(host, second);
    await typeSuffix("待办");
    byAttr<HTMLButtonElement>("[data-tab-suffix-save]")!.click();
    await settle();
    expect(store.tabs.find((tab) => tab.id === second)?.titleSuffix).toBe("待办");
    expect(pill(host, second).querySelector("[data-tab-title-suffix]")?.textContent).toBe("待办");
    // The title itself is untouched, so the object it points at stays visible.
    expect(pill(host, second).querySelector(".truncate")?.textContent).toBeTruthy();

    // Giving the other tab the same suffix.
    await openSuffixEditor(host, first);
    await typeSuffix("待办");
    byAttr<HTMLButtonElement>("[data-tab-suffix-save]")!.click();
    await settle();
    if (collides) {
      expect(byAttr("[data-tab-suffix-duplicate]")).not.toBeNull();
      expect(store.tabs.find((tab) => tab.id === first)?.titleSuffix).toBeUndefined();
    } else {
      // The two tabs already read differently, so the same suffix is not a clash.
      expect(byAttr("[data-tab-suffix-duplicate]")).toBeNull();
      expect(store.tabs.find((tab) => tab.id === first)?.titleSuffix).toBe("待办");
    }

    app.unmount();
    host.remove();
  });

  it("renders the suffix beside the truncating title and ellipsizes only the suffix itself when space runs out", async () => {
    const { store, first, second } = openTwoDataTabs();
    store.setTabTitleSuffix(second, "待审核");
    const { app, host } = mountBar(store.groups[0].id, [first, second], first, pinia);
    await settle();

    const tab = pill(host, second);
    const suffix = tab.querySelector<HTMLElement>("[data-tab-title-suffix]")!;
    expect(suffix.textContent).toBe("待审核");
    // A sibling of the title, not inside it: the title gives way first.
    expect(suffix.closest(".truncate")).toBeNull();
    const title = tab.querySelector<HTMLElement>(".truncate")!;
    expect(title.textContent).not.toContain("待审核");
    expect(title.classList.contains("min-w-0")).toBe(true);
    // The suffix keeps its width until the whole title area is used up...
    expect(suffix.classList.contains("shrink-0")).toBe(true);
    expect(suffix.classList.contains("whitespace-nowrap")).toBe(true);
    // ...and only then ends in an ellipsis instead of being clipped hard.
    expect(suffix.classList.contains("max-w-full")).toBe(true);
    expect(suffix.classList.contains("overflow-hidden")).toBe(true);
    expect(suffix.classList.contains("text-ellipsis")).toBe(true);
    // Both live in one shrinkable container, so max-w-full resolves against it.
    expect(suffix.parentElement).toBe(title.parentElement);
    expect(suffix.parentElement!.classList.contains("min-w-0")).toBe(true);
    expect(suffix.parentElement!.classList.contains("overflow-hidden")).toBe(true);

    app.unmount();
    host.remove();
  });

  it("tells the user the suffix length limit in the dialog", async () => {
    const { store, first, second } = openTwoDataTabs();
    const { app, host } = mountBar(store.groups[0].id, [first, second], first, pinia);
    await settle();

    await openSuffixEditor(host, second);

    expect(TAB_TITLE_SUFFIX_MAX_LENGTH).toBe(8);
    expect(byAttr("[data-tab-suffix-limit]")?.textContent?.trim()).toBe("Maximum 8 characters.");

    app.unmount();
    host.remove();
  });

  it("saves a unique suffix straight from the dialog without asking for confirmation", async () => {
    const { store, first, second } = openTwoDataTabs();
    const { app, host } = mountBar(store.groups[0].id, [first, second], first, pinia);
    await settle();

    await openSuffixEditor(host, second);
    await typeSuffix("待办");
    byAttr<HTMLButtonElement>("[data-tab-suffix-save]")!.click();
    await settle();

    expect(byAttr("[data-tab-suffix-duplicate]")).toBeNull();
    expect(store.tabs.find((tab) => tab.id === second)?.titleSuffix).toBe("待办");
    expect(pill(host, second).querySelector("[data-tab-title-suffix]")?.textContent).toBe("待办");
    expect(byAttr("[data-tab-suffix-input]")).toBeNull();

    app.unmount();
    host.remove();
  });

  it("warns instead of saving when another tab already shows the same suffix", async () => {
    const { store, first, second } = openTwoDataTabs();
    store.setTabTitleSuffix(first, "待办");
    const { app, host } = mountBar(store.groups[0].id, [first, second], first, pinia);
    await settle();

    await openSuffixEditor(host, second);
    await typeSuffix("待办");
    byAttr<HTMLButtonElement>("[data-tab-suffix-save]")!.click();
    await settle();

    const warning = byAttr("[data-tab-suffix-duplicate]");
    expect(warning).not.toBeNull();
    // The warning names the tab that already uses the suffix.
    expect(warning!.textContent).toContain("users");
    expect(warning!.textContent).toContain("待办");
    // Nothing is applied until the user confirms.
    expect(store.tabs.find((tab) => tab.id === second)?.titleSuffix).toBeUndefined();

    app.unmount();
    host.remove();
  });

  it("returns to the editor without saving when the user backs out of the duplicate warning", async () => {
    const { store, first, second } = openTwoDataTabs();
    store.setTabTitleSuffix(first, "待办");
    const { app, host } = mountBar(store.groups[0].id, [first, second], first, pinia);
    await settle();

    await openSuffixEditor(host, second);
    await typeSuffix("待办");
    byAttr<HTMLButtonElement>("[data-tab-suffix-save]")!.click();
    await settle();
    byAttr<HTMLButtonElement>("[data-tab-suffix-duplicate-back]")!.click();
    await settle();

    expect(byAttr("[data-tab-suffix-duplicate]")).toBeNull();
    expect(byAttr<HTMLInputElement>("[data-tab-suffix-input]")?.value).toBe("待办");
    expect(store.tabs.find((tab) => tab.id === second)?.titleSuffix).toBeUndefined();

    app.unmount();
    host.remove();
  });

  it("applies the duplicate suffix once the user confirms", async () => {
    const { store, first, second } = openTwoDataTabs();
    store.setTabTitleSuffix(first, "待办");
    const { app, host } = mountBar(store.groups[0].id, [first, second], first, pinia);
    await settle();

    await openSuffixEditor(host, second);
    await typeSuffix("待办");
    byAttr<HTMLButtonElement>("[data-tab-suffix-save]")!.click();
    await settle();
    byAttr<HTMLButtonElement>("[data-tab-suffix-duplicate-confirm]")!.click();
    await settle();

    expect(store.tabs.find((tab) => tab.id === second)?.titleSuffix).toBe("待办");
    expect(byAttr("[data-tab-suffix-duplicate]")).toBeNull();
    expect(byAttr("[data-tab-suffix-input]")).toBeNull();

    app.unmount();
    host.remove();
  });

  it("also warns when the typed suffix equals another tab's automatic number", async () => {
    const { store, first, second } = openTwoDataTabs();
    const { app, host } = mountBar(store.groups[0].id, [first, second], first, pinia);
    await settle();
    // Both tabs collide on the same title, so the first one is numbered "1".
    expect(pill(host, first).querySelector("[data-tab-title-suffix]")?.textContent).toBe("1");

    await openSuffixEditor(host, second);
    await typeSuffix("1");
    byAttr<HTMLButtonElement>("[data-tab-suffix-save]")!.click();
    await settle();

    expect(byAttr("[data-tab-suffix-duplicate]")).not.toBeNull();

    app.unmount();
    host.remove();
  });

  it("clears the suffix and falls back to the automatic number", async () => {
    const { store, first, second } = openTwoDataTabs();
    store.setTabTitleSuffix(second, "待办");
    const { app, host } = mountBar(store.groups[0].id, [first, second], first, pinia);
    await settle();

    menuButtons(host, second)
      .find((button) => button.textContent === "Clear suffix")!
      .click();
    await settle();

    expect(store.tabs.find((tab) => tab.id === second)?.titleSuffix).toBeUndefined();
    expect(pill(host, second).querySelector("[data-tab-title-suffix]")?.textContent).toBe("2");

    app.unmount();
    host.remove();
  });

  it("limits the suffix input to the length that always fits in the narrowest tab", async () => {
    const { store, first, second } = openTwoDataTabs();
    const { app, host } = mountBar(store.groups[0].id, [first, second], first, pinia);
    await settle();

    await openSuffixEditor(host, second);

    expect(byAttr<HTMLInputElement>("[data-tab-suffix-input]")?.maxLength).toBe(TAB_TITLE_SUFFIX_MAX_LENGTH);

    app.unmount();
    host.remove();
  });

  it("does not save when Enter only confirms an IME composition", async () => {
    const { store, first, second } = openTwoDataTabs();
    const { app, host } = mountBar(store.groups[0].id, [first, second], first, pinia);
    await settle();

    await openSuffixEditor(host, second);
    await typeSuffix("待处理");
    const input = byAttr<HTMLInputElement>("[data-tab-suffix-input]")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    await settle();
    expect(store.tabs.find((tab) => tab.id === second)?.titleSuffix).toBeUndefined();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(store.tabs.find((tab) => tab.id === second)?.titleSuffix).toBe("待处理");

    app.unmount();
    host.remove();
  });
});
