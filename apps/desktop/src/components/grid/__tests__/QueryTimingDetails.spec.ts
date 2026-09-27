// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";
import QueryTimingDetails from "../QueryTimingDetails.vue";
import zh from "@/i18n/locales/zh-CN";

describe("query timing disclosure", () => {
  it("shows only wait, then ordered details on keyboard focus", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(QueryTimingDetails, {
      result: {
        columns: [],
        rows: [],
        affected_rows: 0,
        execution_time_ms: 55,
        client_request_wait_ms: 7030,
        server_execute_time_us: 1019,
        query_timings_ms: { pool_acquire: 350, pool_release: 5, session_prepare: 2, schema: 3, statement_prepare: 1, jdbc_execute: 40, metadata: 2, fetch: 7, trace: 1, audit: 6000, agent_total: 6411 },
      },
      renderMs: 4,
    });
    app.use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zh } }));
    app.mount(host);
    await nextTick();
    expect(host.textContent).toBe("7.0 s");
    expect(host.textContent).not.toContain("数据库执行");
    host.querySelector<HTMLButtonElement>("button")!.focus();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTick();
    const text = document.body.textContent!;
    expect(text).toContain("1.");
    expect(text).not.toContain("读取审计记录");
    expect(text).not.toContain("读取追踪 ID");
    expect(text).not.toContain("数据库计划");
    expect(text).toContain("后端报告耗时");
    expect(text).not.toContain("驱动报告耗时");
    expect(text).toContain("获取连接");
    expect(text).toContain("归还连接");
    const details = document.querySelector('[data-testid="query-timing-details"]')!;
    const stages = [...details.querySelectorAll("tbody tr")].map((row) => row.textContent!);
    // No Core lock sample means both the lock and dependent remainder are absent.
    expect(stages).toHaveLength(12);
    expect([...details.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual(["序号", "阶段", "耗时"]);
    expect(stages.findIndex((s) => s.includes("获取连接"))).toBeLessThan(stages.findIndex((s) => s.includes("会话")));
    expect(stages.findIndex((s) => s.includes("归还连接"))).toBeGreaterThan(stages.findIndex((s) => s.includes("读取结果")));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    app.unmount();
    host.remove();
  });
  it("shows common request stages without inventing JDBC steps for a native or HTTP result", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(QueryTimingDetails, { result: { columns: [], rows: [], affected_rows: 0, execution_time_ms: 4, client_request_wait_ms: 12, client_prepare_ms: 2, client_result_ms: 1 }, renderMs: 3 });
    app.use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zh } }));
    app.mount(host);
    await nextTick();
    host.querySelector<HTMLButtonElement>("button")!.focus();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTick();
    const details = document.querySelector('[data-testid="query-timing-details"]')!;
    expect(details.querySelectorAll("tbody tr")).toHaveLength(4);
    expect(details.textContent).toContain("请求等待");
    expect(details.textContent).not.toContain("JDBC");
    expect(details.textContent).not.toContain("获取连接");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    app.unmount();
    host.remove();
  });
  it("does not substitute execution time when wait or phases are missing", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(QueryTimingDetails, { result: { columns: [], rows: [], affected_rows: 0, execution_time_ms: 55 } });
    app.use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zh } }));
    app.mount(host);
    await nextTick();
    expect(host.textContent).toBe("—");
    app.unmount();
    host.remove();
  });
});
