// @vitest-environment happy-dom

import { createApp, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return { Dialog: passthrough, DialogContent: passthrough, DialogDescription: passthrough, DialogFooter: passthrough, DialogHeader: passthrough, DialogTitle: passthrough };
});

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

vi.mock("@/components/redis/RedisJsonEditor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { modelValue: { type: String, default: "" } },
      setup(props) {
        return () => h("pre", { "data-json-editor": "" }, props.modelValue);
      },
    }),
  };
});

import DataGridDetailDialogs from "../DataGridDetailDialogs.vue";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

function mountDialog(rowDocumentJson?: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const noop = () => {};
  const app = createApp({
    render: () =>
      h(DataGridDetailDialogs, {
        rowOpen: true,
        rowDetail: { rowNumber: 1, rowId: 0, fields: [] },
        columnDetail: null,
        rowDocumentJson,
        typeColorClass: () => "",
        openImagePreview: noop,
        copyRowDetailFieldValue: noop,
        copyColumnDetailFieldValue: noop,
        copyRowDetailJson: noop,
        copyRowDetailTsv: noop,
        copyColumnDetailJson: noop,
        copyColumnDetailTsv: noop,
        copyColumnDetailColumnName: noop,
      }),
  });
  app.use(i18n);
  app.mount(host);
  mountedApps.push({ app, host });
  return host;
}

describe("Row Details JSON tab", () => {
  it("is hidden without a stored document", async () => {
    const host = mountDialog();
    await nextTick();
    expect(host.querySelector("[data-row-detail-view-tabs]")).toBeNull();
  });

  it("shows the stored document after switching to the JSON tab", async () => {
    const json = '{\n  "_id": {\n    "$oid": "6aa1155548fb4dfa03d17f24"\n  }\n}';
    const host = mountDialog(json);
    await nextTick();
    const tabs = host.querySelectorAll<HTMLButtonElement>("[data-row-detail-view-tabs] button");
    expect(tabs).toHaveLength(2);
    expect(host.querySelector("[data-row-detail-document-json]")).toBeNull();
    tabs[1]!.click();
    await nextTick();
    expect(host.querySelector("[data-row-detail-document-json] [data-json-editor]")?.textContent).toBe(json);
    tabs[0]!.click();
    await nextTick();
    expect(host.querySelector("[data-row-detail-document-json]")).toBeNull();
  });
});
