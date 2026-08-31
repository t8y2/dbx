// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const Icon = defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs }) {
      return () => h("span", attrs);
    },
  });
  return Object.fromEntries(["Copy", "Download", "Link2", "Loader2", "Maximize2", "Minimize2", "Network", "Plus", "RefreshCw", "Search", "Table2", "Upload", "X", "ZoomIn", "ZoomOut", "LayoutGrid"].map((name) => [name, Icon]));
});

vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    // Keep this stub on Input's public model API so the test catches accidental
    // reliance on fallthrough value/input attributes.
    Input: defineComponent({
      inheritAttrs: false,
      props: {
        modelValue: { type: [String, Number], default: "" },
      },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () =>
          h("input", {
            value: props.modelValue,
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
          });
      },
    }),
  };
});

async function passthrough(tag: string) {
  const { defineComponent, h } = await import("vue");
  return defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}

vi.mock("@/components/ui/badge", async () => ({ Badge: await passthrough("span") }));
vi.mock("@/components/ui/button", async () => ({ Button: await passthrough("button") }));
vi.mock("@/components/ui/dropdown-menu", async () => ({
  DropdownMenu: await passthrough("div"),
  DropdownMenuContent: await passthrough("div"),
  DropdownMenuItem: await passthrough("button"),
  DropdownMenuTrigger: await passthrough("div"),
}));
vi.mock("@/components/ui/select", async () => ({
  Select: await passthrough("div"),
  SelectContent: await passthrough("div"),
  SelectItem: await passthrough("div"),
  SelectTrigger: await passthrough("button"),
  SelectValue: await passthrough("span"),
}));
vi.mock("@/components/icons/DatabaseIcon.vue", async () => ({ default: await passthrough("span") }));
vi.mock("@/components/connection/ConnectionGroupBadge.vue", async () => ({ default: await passthrough("span") }));

import DiagramToolbar from "../DiagramToolbar.vue";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

function mountToolbar() {
  const search = ref("");
  const updates: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(DiagramToolbar, {
            connectionId: "",
            database: "",
            schema: "",
            databases: [],
            schemas: [],
            sqlConnections: [],
            selectedConnection: undefined,
            isSchemaAware: false,
            loadingDatabases: false,
            loadingSchemas: false,
            loadingDiagram: false,
            diagramReady: false,
            tablesCount: 0,
            relationshipsCount: 0,
            customRelationshipCount: 0,
            matchRelationshipCount: 0,
            diagramMode: "table",
            tableSearch: search.value,
            showMatchPanel: false,
            showLayersPanel: false,
            showAllTables: false,
            focusTableName: "",
            generatedJoinSql: "",
            "onUpdate:table-search": (value: string) => {
              updates.push(value);
              search.value = value;
            },
          });
      },
    }),
  );
  app.mount(host);
  mountedApps.push({ app, host });
  return { host, search, updates };
}

describe("DiagramToolbar", () => {
  it("forwards one search update per typed character through Input's model API", async () => {
    const { host, search, updates } = mountToolbar();
    await nextTick();

    const input = host.querySelector("input") as HTMLInputElement;
    for (const character of "user") {
      input.value += character;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await nextTick();
      await nextTick();
    }

    expect(updates).toEqual(["u", "us", "use", "user"]);
    expect(search.value).toBe("user");
    expect(input.value).toBe("user");
  });
});
