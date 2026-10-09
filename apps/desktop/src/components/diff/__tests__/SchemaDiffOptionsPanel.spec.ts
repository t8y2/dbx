// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSchemaDiffOptionsForDbType } from "@/lib/schema/schemaDiffOptions";
import { DEFAULT_POSTGRES_OPTIONS, normalizeSchemaDiffCompareOptions, type SchemaDiffCompareOptions, type SchemaDiffOptionItem } from "@/types/schemaDiff";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      setup(_props, { attrs, slots }) {
        return () => h("button", attrs, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return { Select: passthrough, SelectContent: passthrough, SelectItem: passthrough, SelectTrigger: passthrough, SelectValue: passthrough };
});

vi.mock("@/components/ui/tooltip", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    HelpTooltip: defineComponent({
      setup(_props, { slots }) {
        return () => h("div", slots.default?.());
      },
    }),
  };
});

import SchemaDiffOptionsPanel from "@/components/diff/SchemaDiffOptionsPanel.vue";

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("SchemaDiffOptionsPanel", () => {
  it("exposes independent case-insensitive name options with false defaults", () => {
    const ids = getSchemaDiffOptionsForDbType("postgres").map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(["ignoreTableNameCase", "ignoreColumnNameCase"]));
    const normalized = normalizeSchemaDiffCompareOptions({});
    expect(normalized.ignoreTableNameCase).toBe(false);
    expect(normalized.ignoreColumnNameCase).toBe(false);
  });

  it("exposes charset comparison only for supported MySQL targets and defaults it on", () => {
    expect(getSchemaDiffOptionsForDbType("mysql").map((item) => item.id)).toContain("compareCharset");
    expect(getSchemaDiffOptionsForDbType("goldendb").map((item) => item.id)).toContain("compareCharset");
    expect(getSchemaDiffOptionsForDbType("starrocks").map((item) => item.id)).not.toContain("compareCharset");
    expect(getSchemaDiffOptionsForDbType("doris").map((item) => item.id)).not.toContain("compareCharset");
    expect(getSchemaDiffOptionsForDbType("postgres").map((item) => item.id)).not.toContain("compareCharset");
    expect(normalizeSchemaDiffCompareOptions({}, "mysql").compareCharset).toBe(true);
  });

  it("groups MySQL charset comparison with table structure options", async () => {
    const host = document.createElement("div");
    document.body.append(host);

    const app = createApp(SchemaDiffOptionsPanel, {
      options: normalizeSchemaDiffCompareOptions({}, "mysql"),
      optionTree: getSchemaDiffOptionsForDbType("mysql"),
    });
    mountedApps.push(app);
    app.mount(host);
    await nextTick();

    const tableStructure = host.querySelector('[data-section="table-structure"]');
    const behavior = host.querySelector('[data-section="compare-behavior"]');
    expect(tableStructure?.textContent).toContain("schemaDiff.options.compareCharset");
    expect(behavior?.textContent).not.toContain("schemaDiff.options.compareCharset");
  });

  it("keeps unsaved checkbox edits when the parent refreshes equivalent options", async () => {
    const options = ref<SchemaDiffCompareOptions>({ ...DEFAULT_POSTGRES_OPTIONS });
    const optionTree: SchemaDiffOptionItem[] = [{ id: "views", labelKey: "views", defaultChecked: true }];
    const updates: SchemaDiffCompareOptions[] = [];
    const host = document.createElement("div");
    document.body.append(host);

    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(SchemaDiffOptionsPanel, {
              options: options.value,
              optionTree,
              "onUpdate:options": (value: SchemaDiffCompareOptions) => updates.push(value),
            });
        },
      }),
    );
    mountedApps.push(app);
    app.mount(host);
    await nextTick();

    const optionLabel = Array.from(host.querySelectorAll("span")).find((element) => element.textContent === "views");
    const optionRow = optionLabel?.parentElement as HTMLElement;
    expect(optionRow.querySelector("svg")).not.toBeNull();

    optionRow.click();
    await nextTick();
    expect(optionRow.querySelector("svg")).toBeNull();

    options.value = { ...options.value };
    await nextTick();
    expect(optionRow.querySelector("svg")).toBeNull();

    const doneButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("common.done"));
    doneButton?.click();
    await nextTick();
    expect(updates).toHaveLength(1);
    expect(updates[0].views).toBe(false);
  });
});
