// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it } from "vitest";

import DataGridCellDetailForeignKey, { type ForeignKeyRowPreviewState } from "../DataGridCellDetailForeignKey.vue";
import { Tabs } from "@/components/ui/tabs";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      grid: {
        foreignKeyPreview: "Referenced Row",
        foreignKeyPreviewOpen: "Open table",
        foreignKeyPreviewLoading: "Loading the referenced row…",
        foreignKeyPreviewEmpty: 'No row in "{table}" matches this value.',
        foreignKeyPreviewFailed: "Could not load the referenced row: {message}",
      },
    },
  },
});

function mountPreview(preview: ForeignKeyRowPreviewState, onOpen = () => {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      render: () => h(Tabs, { modelValue: "foreignKey" }, () => h(DataGridCellDetailForeignKey, { preview, onOpen })),
    }),
  );
  app.use(i18n);
  app.mount(host);
  mountedApps.push({ app, host });
  return host;
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGridCellDetailForeignKey", () => {
  it("lists the columns of the referenced row and shows NULL for missing values", async () => {
    const host = mountPreview({ status: "ready", table: "shop.users", columns: ["id", "name", "note"], row: [2033, "Ada Lovelace", null], message: "" });
    await nextTick();

    expect(host.textContent).toContain("shop.users");
    expect(host.textContent).toContain("2033");
    expect(host.textContent).toContain("Ada Lovelace");
    expect(host.textContent).toContain("NULL");
  });

  it("explains an empty lookup, a failure and the loading state", async () => {
    expect(mountPreview({ status: "empty", table: "users", columns: [], row: [], message: "" }).textContent).toContain('No row in "users" matches this value.');
    expect(mountPreview({ status: "error", table: "users", columns: [], row: [], message: "boom" }).textContent).toContain("Could not load the referenced row: boom");
    expect(mountPreview({ status: "loading", table: "users", columns: [], row: [], message: "" }).textContent).toContain("Loading the referenced row");
  });

  it("emits open from the button", async () => {
    let opened = 0;
    const host = mountPreview({ status: "ready", table: "users", columns: ["id"], row: [1], message: "" }, () => (opened += 1));
    await nextTick();

    host.querySelector<HTMLButtonElement>("button")!.click();
    expect(opened).toBe(1);
  });
});
