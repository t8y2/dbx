// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import en from "@/i18n/locales/en";
import { parseDb2ExplainText } from "@/lib/diagram/explainPlan";
import ExplainPlanViewer from "@/components/explain/ExplainPlanViewer.vue";

vi.mock("@/components/redis/RedisJsonEditor.vue", () => ({
  default: defineComponent({
    props: { modelValue: { type: String, required: true }, readOnly: Boolean },
    setup: (props) => () => h("div", { "data-testid": "json-editor", "data-read-only": String(props.readOnly) }, props.modelValue),
  }),
}));

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
});

const raw = JSON.stringify(
  {
    version: 1,
    databaseType: "db2",
    requestTag: "dbx8834test",
    operators: [
      { id: "1", type: "RETURN", totalCost: "0.75" },
      { id: "2", type: "TBSCAN", totalCost: "0.5" },
    ],
    streams: [
      { id: "1", sourceType: "O", sourceId: "2", targetType: "O", targetId: "1", rowCount: "12" },
      { id: "2", sourceType: "D", sourceId: "-1", targetType: "O", targetId: "2", objectSchema: "APP_A", objectName: "ORDERS" },
    ],
    predicates: [{ operatorId: "2", text: "ID > 1" }],
  },
  null,
  2,
);

describe("DB2 explain viewer", () => {
  it.each(["canvas", "tree", "summary", "raw"] as const)("displays the %s view with timerons and no measured statistics or fake heat", async (view) => {
    const container = document.createElement("div");
    document.body.append(container);
    app = createApp(ExplainPlanViewer, { plan: parseDb2ExplainText(raw), defaultView: view });
    app.use(createI18n({ legacy: false, locale: "en", messages: { en } }));
    app.mount(container);
    await nextTick();
    expect(container.textContent).toContain("DB2");
    expect(container.textContent).toContain("JSON");
    expect(container.textContent).not.toContain("ANALYZE");
    expect(container.textContent).not.toContain("ACTUAL");
    expect(container.textContent).not.toContain("µs");
    expect(container.textContent).not.toContain(en.explain.legendHeat);
    expect(container.textContent).not.toContain(en.explain.costShare);
    if (view === "raw") {
      expect(container.textContent).toContain(raw);
      expect(container.querySelector("[data-testid='json-editor']")?.getAttribute("data-read-only")).toBe("true");
    } else {
      expect(container.textContent).toContain("APP_A.ORDERS");
      expect(container.textContent).toContain("timerons");
    }
  });
});
