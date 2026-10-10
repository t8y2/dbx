// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import en from "@/i18n/locales/en";
import zhCN from "@/i18n/locales/zh-CN";
import { parseExplainResult } from "@/lib/diagram/explainPlan";
import ExplainPlanViewer from "@/components/explain/ExplainPlanViewer.vue";

let app: App | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
});

describe("OceanBase estimated time localization", () => {
  it("labels an OceanBase DML plan and its rows as estimates", async () => {
    const plan = parseExplainResult("oceanbase-oracle", {
      columns: ["Query Plan"],
      rows: [[JSON.stringify({ ID: 0, OPERATOR: "UPDATE", NAME: "O14_TEST", "EST.ROWS": 1, "EST.TIME(us)": 7 })]],
      affected_rows: 0,
      execution_time_ms: 1,
    });
    const container = document.createElement("div");
    document.body.append(container);
    app = createApp(ExplainPlanViewer, { plan, defaultView: "summary" });
    app.use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } }));
    app.mount(container);
    await nextTick();

    expect(container.textContent).toContain("估算执行计划");
    expect([...container.querySelectorAll("th")].map((cell) => cell.textContent)).toContain("预估行数");
    expect(container.textContent).toContain("预计耗时: 7 µs");
    expect(container.textContent).not.toContain("实际行数");
  });

  it.each(["canvas", "tree", "summary"] as const)("updates the existing %s view when the locale changes", async (view) => {
    const plan = parseExplainResult("oceanbase-oracle", {
      columns: ["Query Plan"],
      rows: [[JSON.stringify({ ID: 0, OPERATOR: "TABLE FULL SCAN", NAME: "EXAMPLE_TABLE", "EST.TIME(us)": 0, filter: "C1 > 4" })]],
      affected_rows: 0,
      execution_time_ms: 1,
    });
    const originalPlan = JSON.stringify(plan);
    const i18n = createI18n({ legacy: false, locale: "en", messages: { en, "zh-CN": zhCN } });
    const container = document.createElement("div");
    document.body.append(container);
    app = createApp(ExplainPlanViewer, { plan });
    app.use(i18n);
    app.mount(container);
    await nextTick();

    if (view !== "canvas") {
      const label = en.explain[view];
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
      expect(button).toBeDefined();
      button!.click();
      await nextTick();
    }

    expect(container.textContent).toContain("Estimated time");
    expect(container.textContent).toContain("0 µs");
    expect(container.textContent).toContain("C1 > 4");

    i18n.global.locale.value = "zh-CN";
    await nextTick();
    expect(container.textContent).toContain("预计耗时");
    expect(container.textContent).not.toContain("Estimated time");
    expect(container.textContent).toContain("0 µs");
    expect(container.textContent).toContain("C1 > 4");

    i18n.global.locale.value = "en";
    await nextTick();
    expect(container.textContent).toContain("Estimated time");
    expect(container.textContent).not.toContain("预计耗时");
    expect(JSON.stringify(plan)).toBe(originalPlan);
  });
});
