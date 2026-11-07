// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const store = vi.hoisted(() => ({
  config: undefined as Partial<ConnectionConfig> | undefined,
  setVisibleDatabaseFilter: vi.fn(async () => {}),
  clearVisibleDatabases: vi.fn(async () => {}),
  setVisibleSchemas: vi.fn(async () => {}),
}));

function passthrough(tag: string) {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }),
}));
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: {
    props: ["items"],
    setup:
      (props: { items: unknown[] }, { slots }: { slots: { default: (value: { item: unknown }) => unknown[] } }) =>
      () =>
        h(
          "div",
          props.items.flatMap((item) => slots.default({ item })),
        ),
  },
}));
vi.mock("@/components/ui/input", () => ({
  Input: defineComponent({
    inheritAttrs: false,
    props: { modelValue: String },
    emits: ["update:modelValue"],
    setup(props, { attrs, emit }) {
      return () => h("input", { ...attrs, value: props.modelValue, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) });
    },
  }),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: defineComponent({
    props: { open: Boolean },
    setup(props, { slots }) {
      return () => (props.open ? h("div", slots.default?.()) : null);
    },
  }),
  DialogContent: passthrough("div"),
  DialogFooter: passthrough("div"),
  DialogHeader: passthrough("div"),
  DialogTitle: passthrough("div"),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => store.config,
    ensureConnected: async () => {},
    recordPrimaryVisibleObjectNames: () => {},
    setVisibleDatabaseFilter: store.setVisibleDatabaseFilter,
    clearVisibleDatabases: store.clearVisibleDatabases,
    clearVisibleSchemas: async () => {},
    setVisibleSchemas: store.setVisibleSchemas,
  }),
}));
vi.mock("@/lib/backend/api", () => ({
  listDatabases: async () => ["ak_orders", "ak_users", "billing", "mysql"].map((name) => ({ name })),
  listSchemas: async () => ["APP", "SALES", "SYS", "SYSRAC", "NEW_SCHEMA"],
  executeQuery: async () => ({ columns: ["USERNAME"], rows: [["SYS"], ["SYSRAC"]] }),
}));

import VisibleDatabasesDialog from "@/components/sidebar/VisibleDatabasesDialog.vue";

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

beforeEach(() => {
  store.setVisibleDatabaseFilter.mockClear();
  store.clearVisibleDatabases.mockClear();
  store.setVisibleSchemas.mockClear();
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountDialog(config: Partial<ConnectionConfig>) {
  app?.unmount();
  root?.remove();
  store.config = { id: "conn-1", name: "mysql", db_type: "mysql", ...config };
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(VisibleDatabasesDialog, { open: true, connectionId: "conn-1", connectionName: "mysql" });
  app.mount(root);
  await flush();
}

function row(name: string): HTMLButtonElement {
  const element = root!.querySelector<HTMLButtonElement>(`[data-visible-database-row="${name}"]`);
  if (!element) throw new Error(`missing row ${name}`);
  return element;
}

function button(label: string): HTMLButtonElement {
  const element = [...root!.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!element) throw new Error(`missing button ${label}`);
  return element;
}

function selectedCountText(): string {
  return root!.textContent?.match(/visibleDatabases\.selectedCount:(\{[^}]*\})/)?.[1] ?? "";
}

async function typePatterns(value: string) {
  const input = root!.querySelector<HTMLInputElement>("[data-visible-database-patterns]")!;
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await flush();
}

async function click(element: HTMLElement) {
  element.click();
  await flush();
}

describe("VisibleDatabasesDialog schema migration", () => {
  it("initializes old root list and patterns as checked names, including explicitly selected system schemas", async () => {
    await mountDialog({ db_type: "oracle", database: "XE", visible_databases: ["SYS"], visible_database_patterns: ["SA%"], show_system_schemas: false });
    expect(root!.querySelector('[data-schema-row="SYS"]')?.getAttribute("aria-checked")).toBe("true");
    expect(root!.querySelector('[data-schema-row="SALES"]')?.getAttribute("aria-checked")).toBe("true");
    expect(root!.querySelector('[data-schema-row="NEW_SCHEMA"]')?.getAttribute("aria-checked")).toBe("false");
    expect(store.setVisibleSchemas).not.toHaveBeenCalled();
    await click(button("visibleDatabases.save"));
    expect(store.setVisibleSchemas).toHaveBeenCalledWith("conn-1", "XE", ["SALES", "SYS"], { names: ["APP", "SALES", "SYS", "SYSRAC", "NEW_SCHEMA"], systemNames: new Set(["SYS", "SYSRAC"]) });
  });
  it("keeps an explicit scope ahead of old settings and allows saving no schemas", async () => {
    await mountDialog({ db_type: "oracle", database: "XE", visible_schemas: { XE: ["APP", "UNAVAILABLE"] }, visible_database_patterns: ["%"], show_system_schemas: true });
    expect(root!.querySelector('[data-schema-row="SALES"]')?.getAttribute("aria-checked")).toBe("false");
    await click(button("visibleDatabases.save"));
    expect(store.setVisibleSchemas).toHaveBeenLastCalledWith("conn-1", "XE", ["APP", "UNAVAILABLE"], expect.objectContaining({ names: ["APP", "SALES", "SYS", "SYSRAC", "NEW_SCHEMA"], systemNames: new Set(["SYS", "SYSRAC"]) }));
    await click(button("visibleDatabases.clear"));
    expect(button("visibleDatabases.save").disabled).toBe(false);
    await click(button("visibleDatabases.save"));
    expect(store.setVisibleSchemas).toHaveBeenLastCalledWith("conn-1", "XE", [], expect.objectContaining({ names: ["APP", "SALES", "SYS", "SYSRAC", "NEW_SCHEMA"], systemNames: new Set(["SYS", "SYSRAC"]) }));
  });
});

describe("VisibleDatabasesDialog wildcard patterns (#14221)", () => {
  it("locks pattern matches as checked and saves a pattern-only filter once the checks are cleared", async () => {
    await mountDialog({});
    expect(selectedCountText()).toBe('{"selected":3,"total":3}');

    await typePatterns("%ak%");
    await click(button("visibleDatabases.clear"));

    expect(row("ak_orders").getAttribute("aria-disabled")).toBe("true");
    expect(row("ak_users").getAttribute("aria-disabled")).toBe("true");
    expect(row("billing").hasAttribute("aria-disabled")).toBe(false);
    expect(selectedCountText()).toBe('{"selected":2,"total":3}');

    // 命中通配符的行点了也不会变成手动勾选。
    await click(row("ak_orders"));
    expect(selectedCountText()).toBe('{"selected":2,"total":3}');

    const save = button("visibleDatabases.save");
    expect(save.disabled).toBe(false);
    await click(save);
    expect(store.setVisibleDatabaseFilter).toHaveBeenCalledWith("conn-1", undefined, ["%ak%"]);
  });

  it("keeps save disabled when nothing is checked and no pattern is set", async () => {
    await mountDialog({});
    await click(button("visibleDatabases.clear"));

    expect(button("visibleDatabases.save").disabled).toBe(true);
    expect(root!.textContent).toContain("visibleDatabases.emptySelection");
  });

  it("reopens a pattern-only filter without turning its matches into manual checks", async () => {
    await mountDialog({ visible_databases: undefined, visible_database_patterns: ["%ak%"] });
    expect(row("ak_orders").getAttribute("aria-disabled")).toBe("true");
    expect(selectedCountText()).toBe('{"selected":2,"total":3}');

    await typePatterns("bill%");
    expect(row("ak_orders").hasAttribute("aria-disabled")).toBe(false);
    expect(row("billing").getAttribute("aria-disabled")).toBe("true");
    expect(selectedCountText()).toBe('{"selected":1,"total":3}');

    await click(button("visibleDatabases.save"));
    expect(store.setVisibleDatabaseFilter).toHaveBeenCalledWith("conn-1", undefined, ["bill%"]);
  });

  it("warns but still saves when the patterns match no database yet", async () => {
    await mountDialog({});
    await click(button("visibleDatabases.clear"));
    await typePatterns("proj_2027%");

    expect(root!.querySelector("[data-visible-database-no-match]")).not.toBeNull();
    const save = button("visibleDatabases.save");
    expect(save.disabled).toBe(false);

    await click(row("billing"));
    expect(root!.querySelector("[data-visible-database-no-match]")).toBeNull();

    await click(row("billing"));
    await click(save);
    expect(store.setVisibleDatabaseFilter).toHaveBeenCalledWith("conn-1", undefined, ["proj_2027%"]);
  });

  it("keeps manual checks next to the patterns", async () => {
    await mountDialog({ visible_databases: ["billing"], visible_database_patterns: ["%ak%"] });
    expect(selectedCountText()).toBe('{"selected":3,"total":3}');

    await click(button("visibleDatabases.save"));
    expect(store.setVisibleDatabaseFilter).not.toHaveBeenCalled();

    await mountDialog({ visible_databases: ["billing"], visible_database_patterns: ["%ak%"] });
    await typePatterns("");
    expect(selectedCountText()).toBe('{"selected":1,"total":3}');
    await click(button("visibleDatabases.save"));
    expect(store.setVisibleDatabaseFilter).toHaveBeenCalledWith("conn-1", ["billing"], []);
  });
});
