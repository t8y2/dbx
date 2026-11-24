// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  tabs: [] as any[],
  recentTabIds: [] as string[],
  closedTabsHistory: [] as any[],
  switchTab: vi.fn(),
  reopenClosedTabEntry: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        "tabs.recentTablesTitle": "Recent Tables",
        "tabs.recentTablesSearch": "Search recent tables",
        "tabs.recentTableOpen": "Open",
        "tabs.recentTableClosed": "Recently closed",
        "tabs.noMatchingTabs": "No matching tabs",
        "tabs.recentClosedTitle": "Recently Closed Tabs",
        "tabs.recentClosedSearch": "Search title, connection, database or SQL preview",
      })[key] ?? key,
  }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => mockState,
}));

vi.mock("@/lib/tabs/tabPresentation", () => ({
  connectionDisplayName: (connectionId: string) => connectionId,
  tabDisplayTitle: (tab: { title: string }) => tab.title,
}));

vi.mock("@/components/layout/TabModeIcon.vue", () => ({
  default: defineComponent({
    setup: () => () => h("span", { "data-test": "tab-mode-icon" }),
  }),
}));

vi.mock("@/components/ui/dialog", () => {
  const passthrough = (tag: string) =>
    defineComponent({
      setup(_, { slots }) {
        return () => h(tag, slots.default?.());
      },
    });

  return {
    Dialog: defineComponent({
      props: { open: Boolean },
      setup(props, { slots }) {
        return () => (props.open ? h("div", { "data-test": "dialog" }, slots.default?.()) : null);
      },
    }),
    DialogContent: passthrough("section"),
    DialogHeader: passthrough("header"),
    DialogTitle: passthrough("h1"),
  };
});

vi.mock("@/components/ui/input", () => ({
  Input: defineComponent({
    inheritAttrs: false,
    props: { modelValue: { type: String, default: "" } },
    emits: ["update:modelValue"],
    setup(props, { emit, attrs }) {
      return () =>
        h("input", {
          ...attrs,
          value: props.modelValue,
          onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
        });
    },
  }),
}));

import RecentClosedTabsDialog from "@/components/tabs/RecentClosedTabsDialog.vue";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function tableTab(id: string, connectionId: string, database: string, schema: string, tableName: string) {
  return {
    id,
    title: tableName,
    connectionId,
    database,
    schema,
    sql: "",
    mode: "data",
    isExecuting: false,
    tableMeta: { database, schema, tableName, columns: [], primaryKeys: [] },
  };
}

function closedEntry(tab: ReturnType<typeof tableTab>) {
  return { tab, groupId: "main", indexInGroup: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  const openOrders = tableTab("open-orders", "conn-1", "db", "public", "orders");
  const openOtherSchema = tableTab("open-other-schema", "conn-1", "db", "analytics", "orders");
  const openOtherConnection = tableTab("open-other-connection", "conn-2", "db", "public", "orders");
  const closedDuplicate = tableTab("closed-duplicate", "conn-1", "db", "public", "orders");
  const closedArchive = tableTab("closed-archive", "conn-1", "db", "public", "archive_orders");

  mockState.tabs = [openOrders, openOtherSchema, openOtherConnection, { id: "query", title: "query.sql", connectionId: "conn-1", database: "db", schema: "public", sql: "select 1", mode: "query", isExecuting: false }];
  mockState.recentTabIds = [openOtherConnection.id, openOrders.id, openOtherSchema.id];
  mockState.closedTabsHistory = [closedEntry(closedDuplicate), closedEntry(closedArchive)];
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

async function mountPicker() {
  const host = document.createElement("div");
  document.body.append(host);
  const onUpdateOpen = vi.fn();
  const app = createApp(RecentClosedTabsDialog, { open: true, tablesOnly: true, "onUpdate:open": onUpdateOpen });
  app.mount(host);
  mountedApps.push({ app, host });
  await nextTick();
  return { host, onUpdateOpen };
}

function rows(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("[data-recent-closed-tab]")];
}

function rowContaining(host: HTMLElement, ...parts: string[]): HTMLButtonElement {
  const row = rows(host).find((candidate) => parts.every((part) => candidate.textContent?.includes(part)));
  expect(row, parts.join(" / ")).toBeTruthy();
  return row!;
}

describe("RecentClosedTabsDialog table picker", () => {
  it("lists data tabs, prefers open tabs, and keeps scopes isolated", async () => {
    const { host } = await mountPicker();

    expect(rows(host)).toHaveLength(4);
    expect(rowContaining(host, "orders", "conn-1", "analytics", "Open")).toBeTruthy();
    expect(rowContaining(host, "orders", "conn-1", "public", "Open")).toBeTruthy();
    expect(rowContaining(host, "orders", "conn-2", "public", "Open")).toBeTruthy();
    expect(rowContaining(host, "archive_orders", "conn-1", "Recently closed")).toBeTruthy();
    expect(rows(host).some((row) => row.textContent?.includes("Recently closed") && !row.textContent?.includes("archive_orders"))).toBe(false);
  });

  it("filters identifiers and switches to an open table", async () => {
    const { host, onUpdateOpen } = await mountPicker();
    const input = host.querySelector<HTMLInputElement>("input")!;

    input.value = "arch";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(rows(host)).toHaveLength(1);
    expect(rows(host)[0]?.textContent).toContain("archive_orders");

    input.value = "orders";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    rowContaining(host, "orders", "conn-1", "public", "Open").click();

    expect(mockState.switchTab).toHaveBeenCalledOnce();
    expect(mockState.switchTab).toHaveBeenCalledWith("open-orders");
    expect(mockState.reopenClosedTabEntry).not.toHaveBeenCalled();
    expect(onUpdateOpen).toHaveBeenCalledWith(false);
  });

  it("reopens a closed table with Enter after filtering", async () => {
    const { host, onUpdateOpen } = await mountPicker();
    const input = host.querySelector<HTMLInputElement>("input")!;

    input.value = "archive";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(mockState.reopenClosedTabEntry).toHaveBeenCalledOnce();
    expect(mockState.reopenClosedTabEntry).toHaveBeenCalledWith(mockState.closedTabsHistory[1]);
    expect(mockState.switchTab).not.toHaveBeenCalled();
    expect(onUpdateOpen).toHaveBeenCalledWith(false);
  });
});
