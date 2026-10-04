// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
import { createI18n } from "vue-i18n";
import en from "@/i18n/locales/en";
import zhCN from "@/i18n/locales/zh-CN";
import { parseExplainResult } from "@/lib/diagram/explainPlan";
import ExplainPlanViewer from "@/components/explain/ExplainPlanViewer.vue";
import type { QueryResult } from "@/types/database";

let app: App | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
});

function createMockPlan() {
  return parseExplainResult("mysql", {
    columns: ["EXPLAIN"],
    rows: [[JSON.stringify({ query_block: { select_id: 1, cost_info: { query_cost: "1.00" }, table: { table_name: "users", access_type: "ALL", rows_examined_per_scan: 10 } } })]],
    affected_rows: 0,
    execution_time_ms: 1,
  });
}

const mockTableResult: QueryResult = {
  columns: ["id", "select_type", "table", "type", "rows"],
  rows: [[1, "SIMPLE", "users", "ALL", 10]],
  affected_rows: 1,
  execution_time_ms: 1,
};

describe("ExplainPlanViewer defaultView prop", () => {
  it("defaults to canvas view when defaultView is not specified", async () => {
    const plan = createMockPlan();
    const i18n = createI18n({ legacy: false, locale: "en", messages: { en, "zh-CN": zhCN } });
    const container = document.createElement("div");
    document.body.append(container);

    app = createApp(ExplainPlanViewer, {
      plan,
      tableResult: mockTableResult,
    });
    app.use(i18n);
    app.mount(container);
    await nextTick();

    // Canvas button should have the secondary variant (active), and table button should be ghost
    const canvasBtn = [...container.querySelectorAll("button")].find((btn) => btn.textContent?.includes("Canvas"));
    const tableBtn = [...container.querySelectorAll("button")].find((btn) => btn.textContent?.includes("Table"));

    expect(canvasBtn).toBeDefined();
    expect(tableBtn).toBeDefined();
    expect(canvasBtn?.className).toContain("bg-secondary");
    expect(tableBtn?.className).not.toContain("bg-secondary");
  });

  it("defaults to standard table view when defaultView is table and tableResult is present", async () => {
    const plan = createMockPlan();
    const i18n = createI18n({ legacy: false, locale: "en", messages: { en, "zh-CN": zhCN } });
    const container = document.createElement("div");
    document.body.append(container);

    app = createApp(ExplainPlanViewer, {
      plan,
      tableResult: mockTableResult,
      defaultView: "table",
    });
    app.use(i18n);
    app.mount(container);
    await nextTick();

    const canvasBtn = [...container.querySelectorAll("button")].find((btn) => btn.textContent?.includes("Canvas"));
    const tableBtn = [...container.querySelectorAll("button")].find((btn) => btn.textContent?.includes("Table"));

    expect(canvasBtn?.className).not.toContain("bg-secondary");
    expect(tableBtn?.className).toContain("bg-secondary");
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.textContent).toContain("SIMPLE");
  });

  it("falls back to canvas view when defaultView is table but tableResult is not available", async () => {
    const plan = createMockPlan();
    const i18n = createI18n({ legacy: false, locale: "en", messages: { en, "zh-CN": zhCN } });
    const container = document.createElement("div");
    document.body.append(container);

    app = createApp(ExplainPlanViewer, {
      plan,
      defaultView: "table",
    });
    app.use(i18n);
    app.mount(container);
    await nextTick();

    const canvasBtn = [...container.querySelectorAll("button")].find((btn) => btn.textContent?.includes("Canvas"));
    expect(canvasBtn?.className).toContain("bg-secondary");
  });

  it("defaults to tree view when defaultView is tree", async () => {
    const plan = createMockPlan();
    const i18n = createI18n({ legacy: false, locale: "en", messages: { en, "zh-CN": zhCN } });
    const container = document.createElement("div");
    document.body.append(container);

    app = createApp(ExplainPlanViewer, {
      plan,
      tableResult: mockTableResult,
      defaultView: "tree",
    });
    app.use(i18n);
    app.mount(container);
    await nextTick();

    const treeBtn = [...container.querySelectorAll("button")].find((btn) => btn.textContent?.includes("Tree"));
    expect(treeBtn?.className).toContain("bg-secondary");
  });

  it("defaults to summary view when defaultView is summary", async () => {
    const plan = createMockPlan();
    const i18n = createI18n({ legacy: false, locale: "en", messages: { en, "zh-CN": zhCN } });
    const container = document.createElement("div");
    document.body.append(container);

    app = createApp(ExplainPlanViewer, {
      plan,
      tableResult: mockTableResult,
      defaultView: "summary",
    });
    app.use(i18n);
    app.mount(container);
    await nextTick();

    const summaryBtn = [...container.querySelectorAll("button")].find((btn) => btn.textContent?.includes("Summary"));
    expect(summaryBtn?.className).toContain("bg-secondary");
  });

  it("defaults to raw view when defaultView is raw", async () => {
    const plan = createMockPlan();
    const i18n = createI18n({ legacy: false, locale: "en", messages: { en, "zh-CN": zhCN } });
    const container = document.createElement("div");
    document.body.append(container);

    app = createApp(ExplainPlanViewer, {
      plan,
      tableResult: mockTableResult,
      defaultView: "raw",
    });
    app.use(i18n);
    app.mount(container);
    await nextTick();

    const rawBtn = [...container.querySelectorAll("button")].find((btn) => btn.textContent?.includes("JSON"));
    expect(rawBtn?.className).toContain("bg-secondary");
  });

  it("allows switching views by clicking buttons and resets to default on new execution", async () => {
    const plan = createMockPlan();
    const i18n = createI18n({ legacy: false, locale: "en", messages: { en, "zh-CN": zhCN } });
    const container = document.createElement("div");
    document.body.append(container);

    const loadingRef = ref(false);
    const sourceSqlRef = ref("SELECT * FROM users");

    const Wrapper = {
      setup() {
        return () =>
          h(ExplainPlanViewer, {
            plan,
            tableResult: mockTableResult,
            defaultView: "table",
            loading: loadingRef.value,
            sourceSql: sourceSqlRef.value,
          });
      },
    };

    app = createApp(Wrapper);
    app.use(i18n);
    app.mount(container);
    await nextTick();

    const canvasBtn = () => [...container.querySelectorAll("button")].find((btn) => btn.textContent?.includes("Canvas"));
    const tableBtn = () => [...container.querySelectorAll("button")].find((btn) => btn.textContent?.includes("Table"));

    expect(tableBtn()?.className).toContain("bg-secondary");

    // Manually click canvas
    canvasBtn()!.click();
    await nextTick();
    expect(canvasBtn()?.className).toContain("bg-secondary");
    expect(tableBtn()?.className).not.toContain("bg-secondary");

    // Trigger a new execution
    loadingRef.value = true;
    await nextTick();
    loadingRef.value = false;
    await nextTick();

    // Should reset back to defaultView ("table")
    expect(tableBtn()?.className).toContain("bg-secondary");
    expect(canvasBtn()?.className).not.toContain("bg-secondary");
  });
});
