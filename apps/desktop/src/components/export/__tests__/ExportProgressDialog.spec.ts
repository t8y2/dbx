// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return { Dialog: passthrough, DialogContent: passthrough, DialogHeader: passthrough, DialogTitle: passthrough, DialogFooter: passthrough };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      setup(_props, { slots }) {
        return () => h("button", slots.default?.());
      },
    }),
  };
});

import ExportProgressDialog from "@/components/export/ExportProgressDialog.vue";

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function mountDialog(props: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(ExportProgressDialog, props);
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
}

const baseProps = {
  open: true,
  title: "Export Table Data",
  tableName: "Query Result",
  format: "sql",
  rowsExported: 10,
  totalRows: 10,
  status: "Done",
  errorMessage: null,
};

describe("ExportProgressDialog display name", () => {
  it("shows the real saved file name instead of the synthetic table label", async () => {
    i18n.global.locale.value = "en";
    await mountDialog({ ...baseProps, filePath: "C:\\exports\\自定义.sql" });

    expect(document.body.textContent).toContain("自定义.sql");
    expect(document.body.textContent).not.toContain("Query Result (.sql)");
    const titleHolder = [...document.body.querySelectorAll("[title]")].find((el) => el.getAttribute("title") === "C:\\exports\\自定义.sql");
    expect(titleHolder).toBeTruthy();
  });

  it("falls back to the table label when no file path is available", async () => {
    i18n.global.locale.value = "en";
    await mountDialog({ ...baseProps, tableName: "audit_log", format: "csv", filePath: null });

    expect(document.body.textContent).toContain("audit_log (.csv)");
  });
});
