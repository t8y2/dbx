// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import i18n from "@/i18n";
import type { DatabaseSearchResultItem, DatabaseSearchTabState } from "@/types/database";
import type { NavigationTarget } from "@/composables/useNavigationTargets";

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  const dialog = defineComponent({
    props: { open: Boolean },
    emits: ["update:open"],
    setup(props, { slots }) {
      return () => (props.open ? h("div", slots.default?.()) : null);
    },
  });
  return {
    Dialog: dialog,
    DialogScrollContent: passthrough,
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
      props: { disabled: Boolean, variant: String, size: String },
      emits: ["click"],
      setup(props, { slots, emit }) {
        return () =>
          h(
            "button",
            {
              disabled: props.disabled,
              onClick: (e: MouseEvent) => emit("click", e),
            },
            slots.default?.(),
          );
      },
    }),
  };
});

vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      props: { modelValue: [String, Number], disabled: Boolean, placeholder: String, type: String },
      emits: ["update:modelValue", "keydown"],
      setup(props, { emit }) {
        return () =>
          h("input", {
            value: props.modelValue,
            disabled: props.disabled,
            placeholder: props.placeholder,
            type: props.type || "text",
            onInput: (e: any) => emit("update:modelValue", e.target.value),
            onKeydown: (e: any) => emit("keydown", e),
          });
      },
    }),
  };
});

vi.mock("@/components/ui/badge", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Badge: defineComponent({
      setup(_props, { slots }) {
        return () => h("span", slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/label", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Label: defineComponent({
      setup(_props, { slots }) {
        return () => h("label", slots.default?.());
      },
    }),
  };
});

import DatabaseSearchPanel from "@/components/search/DatabaseSearchPanel.vue";
import DatabaseSearchDialog from "@/components/search/DatabaseSearchDialog.vue";
import { useQueryStore } from "@/stores/queryStore";

const mountedApps: App[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("DatabaseSearchPanel", () => {
  it("restores search results and keyword from initialState", async () => {
    const initialState: DatabaseSearchTabState = {
      keyword: "admin_user",
      perTableLimit: 30,
      progressDone: 3,
      progressTotal: 10,
      results: [
        {
          id: "users:0",
          tableName: "users",
          schema: "public",
          matchedColumns: ["username"],
          preview: "username: admin_user",
          whereInput: "\"username\" = 'admin_user'",
        },
      ],
    };

    let emittedTarget: NavigationTarget | null = null;
    const container = document.createElement("div");
    document.body.append(container);

    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(DatabaseSearchPanel, {
              connectionId: "conn-1",
              database: "shop",
              schema: "public",
              initialState,
              inDialog: false,
              "onOpen-target": (target: NavigationTarget) => {
                emittedTarget = target;
              },
            });
        },
      }),
    );
    app.use(i18n);
    mountedApps.push(app);
    app.mount(container);
    await nextTick();

    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("admin_user");

    const resultButtons = container.querySelectorAll("button");
    const resultItemBtn = Array.from(resultButtons).find((btn) => btn.textContent?.includes("users"));
    expect(resultItemBtn).toBeDefined();

    resultItemBtn?.click();
    await nextTick();

    expect(emittedTarget).toMatchObject({
      connectionId: "conn-1",
      database: "shop",
      schema: "public",
      tableName: "users",
      whereInput: "\"username\" = 'admin_user'",
    });
  });

  it("updates and emits state when inputs change", async () => {
    let latestState: DatabaseSearchTabState | null = null;
    const container = document.createElement("div");
    document.body.append(container);

    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(DatabaseSearchPanel, {
              connectionId: "conn-1",
              database: "shop",
              "onUpdate:state": (state: DatabaseSearchTabState) => {
                latestState = state;
              },
            });
        },
      }),
    );
    app.use(i18n);
    mountedApps.push(app);
    app.mount(container);
    await nextTick();

    const input = container.querySelector("input") as HTMLInputElement;
    input.value = "new_search";
    input.dispatchEvent(new Event("input"));
    await nextTick();

    expect(latestState?.keyword).toBe("new_search");
  });
});

describe("DatabaseSearchDialog", () => {
  it("opens in tab when openInTab is clicked and transfers search state", async () => {
    const queryStore = useQueryStore();
    const openSpy = vi.spyOn(queryStore, "openDatabaseSearch");

    let open = true;
    const container = document.createElement("div");
    document.body.append(container);

    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(DatabaseSearchDialog, {
              open,
              prefillConnectionId: "conn-1",
              prefillDatabase: "testdb",
              prefillSchema: "public",
              "onUpdate:open": (v: boolean) => {
                open = v;
              },
            });
        },
      }),
    );
    app.use(i18n);
    mountedApps.push(app);
    app.mount(container);
    await nextTick();

    const buttons = Array.from(container.querySelectorAll("button"));
    const openInTabBtn = buttons.find((btn) => btn.textContent?.includes("Open in Tab") || btn.textContent?.includes("页签") || btn.textContent?.includes("分頁"));
    expect(openInTabBtn).toBeDefined();

    openInTabBtn?.click();
    await nextTick();

    expect(openSpy).toHaveBeenCalledWith("conn-1", "testdb", "public", expect.any(Object));
    expect(open).toBe(false);
  });
});
