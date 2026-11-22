// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const store = vi.hoisted(() => ({
  config: undefined as Partial<ConnectionConfig> | undefined,
  setVisibleSchemas: vi.fn(async () => {}),
  clearVisibleSchemas: vi.fn(async () => {}),
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
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    inheritAttrs: false,
    props: { items: { type: Array, default: () => [] } },
    setup(props, { slots }) {
      return () =>
        h(
          "div",
          (props.items as Array<{ name: string }>).map((item) => slots.default?.({ item })),
        );
    },
  }),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => store.config,
    ensureConnected: async () => {},
    setVisibleSchemas: store.setVisibleSchemas,
    clearVisibleSchemas: store.clearVisibleSchemas,
  }),
}));
vi.mock("@/lib/backend/api", () => ({
  listSchemas: async () => ["app_orders", "app_users", "billing", "information_schema", "public"],
}));

import VisibleSchemasDialog from "@/components/sidebar/VisibleSchemasDialog.vue";

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

beforeEach(() => {
  store.setVisibleSchemas.mockClear();
  store.clearVisibleSchemas.mockClear();
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

async function mountDialog(config: Partial<ConnectionConfig> = {}) {
  app?.unmount();
  root?.remove();
  store.config = { id: "conn-1", name: "pg", db_type: "postgres", database: "db1", username: "postgres", ...config };
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(VisibleSchemasDialog, { open: true, connectionId: "conn-1", connectionName: "pg", database: "db1" });
  app.mount(root);
  await flush();
}

function rowNames(): string[] {
  return [...root!.querySelectorAll<HTMLElement>("[data-visible-schema-row]")].map((element) => element.getAttribute("data-visible-schema-row") ?? "");
}

function button(label: string): HTMLButtonElement {
  const element = [...root!.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!element) throw new Error(`missing button ${label}`);
  return element;
}

async function typeSearch(value: string) {
  const input = root!.querySelector<HTMLInputElement>("[data-visible-schema-search]")!;
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await flush();
}

async function click(element: HTMLElement) {
  element.click();
  await flush();
}

describe("VisibleSchemasDialog wildcard search (#15109)", () => {
  it("filters with the % wildcard and selects every match in one click", async () => {
    await mountDialog();
    expect(rowNames()).toEqual(["app_orders", "app_users", "billing", "public"]);

    await typeSearch("app_%");
    expect(rowNames()).toEqual(["app_orders", "app_users"]);
    expect(root!.textContent).toContain('visibleSchemas.searchMatchCount:{"count":2}');

    await click(button("visibleSchemas.selectFiltered"));
    expect(root!.textContent).toContain('visibleSchemas.selectedCount:{"selected":2,"total":4}');

    await click(button("visibleSchemas.save"));
    expect(store.setVisibleSchemas).toHaveBeenCalledWith("conn-1", "db1", ["app_orders", "app_users"]);
  });

  it("keeps plain text as a case-insensitive substring search", async () => {
    await mountDialog();
    await typeSearch("APP_");
    expect(rowNames()).toEqual(["app_orders", "app_users"]);
    expect(root!.textContent).toContain('visibleSchemas.searchMatchCount:{"count":2}');
  });

  it("anchors % patterns instead of matching anywhere", async () => {
    await mountDialog();
    await typeSearch("%orders%");
    expect(rowNames()).toEqual(["app_orders"]);
  });

  it("shows no rows when the pattern matches nothing", async () => {
    await mountDialog();
    await click(button("visibleSchemas.clear"));
    await typeSearch("proj_%");
    expect(rowNames()).toEqual([]);
    expect(root!.textContent).toContain("grid.noSearchResults");
    expect(button("visibleSchemas.save").disabled).toBe(true);
  });

  it("clears the query and restores every listed schema", async () => {
    await mountDialog();
    await typeSearch("app_%");
    expect(rowNames()).toEqual(["app_orders", "app_users"]);
    await typeSearch("");
    expect(rowNames()).toEqual(["app_orders", "app_users", "billing", "public"]);
  });
});
