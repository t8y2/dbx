// @vitest-environment happy-dom
// oxlint-disable-next-line typescript/triple-slash-reference -- Test specs are excluded from the app tsconfig, so the editor needs the Vue declaration explicitly.
/// <reference path="../../../env.d.ts" />

import { createApp, defineComponent, h, nextTick, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  toast: vi.fn(),
}));

function passthrough(tag: string): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
  // The viewer's RedisJsonEditor import pulls in the real i18n module, whose
  // import-time createI18n call must survive this mock.
  createI18n: () => ({ global: { t: (key: string) => key }, install: () => {} }),
}));
vi.mock("@lucide/vue", () => ({
  AlertCircle: passthrough("span"),
  Braces: passthrough("span"),
  Download: passthrough("span"),
  FileText: passthrough("span"),
  GitBranch: passthrough("span"),
  Table2: passthrough("span"),
  Workflow: passthrough("span"),
}));
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: passthrough("div"),
  DropdownMenuContent: passthrough("div"),
  DropdownMenuItem: passthrough("button"),
  DropdownMenuTrigger: passthrough("div"),
}));
vi.mock("@/components/explain/ExplainPlanDiagram.vue", () => ({ default: passthrough("div") }));
vi.mock("@/components/explain/ExplainPlanNodeTree.vue", () => ({ default: passthrough("div") }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/i18n/backend-errors", () => ({ translateBackendError: () => "translated error" }));
vi.mock("@/lib/export/explainPlanExport", () => ({
  EXPLAIN_PLAN_EXPORT_COLUMN_KEYS: ["explain.node", "explain.relation", "explain.index", "explain.cost", "explain.rows", "explain.details"],
  saveExplainPlanExport: mocks.save,
}));

import ExplainPlanViewer from "../ExplainPlanViewer.vue";

const plan = {
  databaseType: "oracle",
  raw: "raw plan",
  nodes: [{ id: "0", title: "SELECT STATEMENT", nodeType: "SELECT STATEMENT", details: [], children: [] }],
};

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

async function mountViewer(props: Record<string, unknown> = {}) {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(ExplainPlanViewer, { plan, ...props });
  app.mount(root);
  await nextTick();
}

function exportItem(label: string): HTMLButtonElement {
  const item = Array.from(root!.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);
  if (!item) throw new Error(`Missing export item: ${label}`);
  return item;
}

beforeEach(() => {
  mocks.save.mockResolvedValue(true);
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
  vi.clearAllMocks();
});

describe("ExplainPlanViewer export", () => {
  it.each([
    ["diagram.exportSvg", "svg"],
    ["diagram.exportPng", "png"],
    ["grid.exportHtml", "html"],
    ["grid.exportCsv", "csv"],
    ["grid.exportXlsx", "xlsx"],
  ] as const)("exports through %s", async (label, format) => {
    await mountViewer();
    exportItem(label).dispatchEvent(new Event("select", { bubbles: true }));

    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save).toHaveBeenCalledWith(plan, format, ["explain.node", "explain.relation", "explain.index", "explain.cost", "explain.rows", "explain.details"], "explain.estimatedTime", "explain.title · ORACLE", {
      cost: "explain.cost",
      estimatedRows: "explain.estRows",
      legendHeat: "explain.legendHeat",
      legendEdge: "explain.legendEdge",
    });
    expect(mocks.toast).toHaveBeenCalledWith("grid.exported");
  });

  it("does not report success when the save dialog is canceled", async () => {
    mocks.save.mockResolvedValueOnce(false);
    await mountViewer();
    exportItem("grid.exportCsv").dispatchEvent(new Event("select", { bubbles: true }));

    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("reports writer failures and disables export when no parsed nodes exist", async () => {
    mocks.save.mockRejectedValueOnce(new Error("disk full"));
    await mountViewer();
    exportItem("grid.exportXlsx").dispatchEvent(new Event("select", { bubbles: true }));

    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("grid.exportFailed", 5000));
    app?.unmount();

    const emptyPlan = { ...plan, nodes: [] };
    app = createApp(ExplainPlanViewer, { plan: emptyPlan });
    app.mount(root!);
    await nextTick();
    const trigger = Array.from(root!.querySelectorAll("button")).find((button) => button.textContent?.trim() === "grid.export");
    expect(trigger?.disabled).toBe(true);
  });
});
