// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import en from "@/i18n/locales/en";
import { parseExplainResult, type ParsedExplainPlan } from "@/lib/diagram/explainPlan";
import ExplainPlanViewer from "@/components/explain/ExplainPlanViewer.vue";

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  toast: vi.fn(),
}));

vi.mock("@/lib/common/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/common/clipboard")>()),
  copyToClipboard: mocks.copyToClipboard,
}));
vi.mock("@/components/redis/RedisJsonEditor.vue", () => ({
  default: defineComponent({
    props: { modelValue: { type: String, required: true }, readOnly: Boolean },
    setup: (props) => () => h("div", { "data-testid": "json-editor", "data-read-only": String(props.readOnly) }, props.modelValue),
  }),
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

let app: App | undefined;

beforeEach(() => {
  mocks.copyToClipboard.mockClear();
  mocks.toast.mockClear();
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
});

function mountViewer(defaultView: "tree" | "raw") {
  const plan = parseExplainResult("oceanbase-oracle", {
    columns: ["Query Plan"],
    rows: [[JSON.stringify({ ID: 0, OPERATOR: "TABLE FULL SCAN", NAME: "EXAMPLE_TABLE", filter: "C1 > 4" })]],
    affected_rows: 0,
    execution_time_ms: 1,
  });
  const container = document.createElement("div");
  document.body.append(container);
  app = createApp(ExplainPlanViewer, { plan, defaultView });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en } }));
  app.mount(container);
  return { plan: plan!, container };
}

describe("ExplainPlanViewer copy", () => {
  it("shows the copy button only inside the raw box", async () => {
    const { container } = mountViewer("tree");
    await nextTick();

    expect(container.querySelector("[data-testid='explain-copy-raw']")).toBeNull();
  });

  it("copies the raw plan from the raw box", async () => {
    const { plan, container } = mountViewer("raw");
    await nextTick();

    const button = container.querySelector<HTMLButtonElement>("[data-testid='explain-copy-raw']");
    expect(button?.textContent?.trim()).toBe("Copy JSON");
    button!.click();
    await nextTick();

    expect(mocks.copyToClipboard).toHaveBeenCalledWith(JSON.stringify(plan.raw, null, 2));
    expect(mocks.toast).toHaveBeenCalledWith("Copied", 1500);
  });

  it("renders the JSON plan in the read-only JSON editor", async () => {
    const { plan, container } = mountViewer("raw");
    await nextTick();

    const editor = container.querySelector("[data-testid='json-editor']");
    expect(editor?.getAttribute("data-read-only")).toBe("true");
    expect(editor?.textContent).toBe(JSON.stringify(plan.raw, null, 2));
    expect(container.querySelector("pre")).toBeNull();
  });

  it("leaves Ctrl+A unhandled outside the raw code block", async () => {
    const { container } = mountViewer("tree");
    await nextTick();

    expect(container.querySelector("[data-native-clipboard][tabindex]")).toBeNull();
  });

  it("selects only the TEXT plan block on Ctrl+A", async () => {
    const plan: ParsedExplainPlan = {
      databaseType: "dameng",
      raw: "1   #NSET2: [1, 1, 0]\n2     #CSCN2: [1, 1, 0]; INDEX33555484(EXAMPLE_TABLE)",
      nodes: [{ id: "1", title: "NSET2", nodeType: "NSET2", details: [], children: [] }],
    };
    const container = document.createElement("div");
    document.body.append(container);
    app = createApp(ExplainPlanViewer, { plan, defaultView: "raw" });
    app.use(createI18n({ legacy: false, locale: "en", messages: { en } }));
    app.mount(container);
    await nextTick();

    expect(container.querySelector("[data-testid='json-editor']")).toBeNull();
    const content = container.querySelector<HTMLElement>("pre[data-native-clipboard][tabindex]");
    expect(content).not.toBeNull();
    const event = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
    content!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    const selected = window.getSelection()?.toString() ?? "";
    expect(selected).toContain("EXAMPLE_TABLE");
    expect(selected).not.toContain("Copy TEXT");
  });
});
