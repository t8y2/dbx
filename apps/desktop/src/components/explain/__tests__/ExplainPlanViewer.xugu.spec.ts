// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import en from "@/i18n/locales/en";
import { parseXuguExplainText } from "@/lib/diagram/xuguExplainPlan";
import ExplainPlanViewer from "@/components/explain/ExplainPlanViewer.vue";

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
});

describe("Xugu explain viewer", () => {
  it.each(["canvas", "tree", "summary", "raw"] as const)("keeps CTE names visible in the %s view", async (view) => {
    const plan = parseXuguExplainText("With Query(Q)\n1   VTScan\nMain Query\n1   WithRef[(1 1)](WithQry=Q)");
    const container = document.createElement("div");
    document.body.append(container);
    app = createApp(ExplainPlanViewer, { plan, defaultView: view });
    app.use(createI18n({ legacy: false, locale: "en", messages: { en } }));
    app.mount(container);
    await nextTick();
    expect(container.textContent).toContain("With Query(Q)");
    expect(container.textContent).toContain("Main Query");
  });

  it.each(["canvas", "tree", "summary", "raw"] as const)("reuses the %s view without measured statistics or fake shares", async (view) => {
    const text = "1   SeqScan[(1 1) cost=0,result_num=12](table=ORDERS)\n-----------------------Tips--------------------------\n1   scan_filter: ID > 1";
    const plan = parseXuguExplainText(text);
    const container = document.createElement("div");
    document.body.append(container);
    app = createApp(ExplainPlanViewer, { plan, defaultView: view });
    app.use(createI18n({ legacy: false, locale: "en", messages: { en } }));
    app.mount(container);
    await nextTick();
    expect(container.textContent).toContain("XUGU");
    expect(container.textContent).toContain("TEXT");
    expect(container.textContent).not.toContain("JSON");
    expect(container.textContent).not.toContain("ANALYZE");
    expect(container.textContent).not.toContain("A-TRACE");
    expect(container.textContent).not.toContain("µs");
    expect(container.textContent).not.toContain(en.explain.legendHeat);
    expect(container.textContent).not.toContain(en.explain.costShare);
    if (view === "raw") expect(container.textContent).toContain(text);
    else expect(container.textContent).toContain("ORDERS");
    if (view === "tree" || view === "canvas") {
      expect(container.textContent).toContain("scan_filter");
      expect(container.textContent).toContain("ID > 1");
    }
  });
});
