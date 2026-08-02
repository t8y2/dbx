// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import i18n from "@/i18n";
import type { ExplainPlanNode } from "@/lib/diagram/explainPlan";
import { parseExplainResult } from "@/lib/diagram/explainPlan";
import type { QueryResult } from "@/types/database";
import ExplainPlanDiagram from "@/components/explain/ExplainPlanDiagram.vue";

function planNode(node: Partial<ExplainPlanNode> & { id: string; nodeType: string }): ExplainPlanNode {
  return { title: node.nodeType, details: [], children: [], ...node };
}

// root(Limit) → Sort → Hash Join → [Seq Scan, Hash → Index Scan]
function postgresPlan(): ExplainPlanNode[] {
  return [
    planNode({
      id: "0",
      nodeType: "Limit",
      cost: "24102.11..24180.37",
      rows: "100",
      children: [
        planNode({
          id: "0.0",
          nodeType: "Sort",
          cost: "24000.00..24102.11",
          rows: "42000",
          details: ["Sort: o.created_at DESC", "Actual Rows: 84000"],
          children: [
            planNode({
              id: "0.0.0",
              nodeType: "Hash Join",
              cost: "0.29..23800.00",
              rows: "42000",
              details: ["Join: Inner"],
              children: [
                planNode({ id: "0.0.0.0", nodeType: "Seq Scan", relation: "orders", cost: "0.00..18000.00", rows: "1200000", details: ["Filter: created_at >= '2026-01-01'"] }),
                planNode({
                  id: "0.0.0.1",
                  nodeType: "Hash",
                  cost: "0.29..1200.00",
                  rows: "18500",
                  children: [planNode({ id: "0.0.0.1.0", nodeType: "Index Scan", relation: "customers", index: "idx_customers_region", cost: "0.29..1100.00", rows: "18500" })],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  ];
}

const mountedApps: App[] = [];

beforeEach(() => {
  i18n.global.locale.value = "en";
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

async function mountDiagram(nodes: ExplainPlanNode[] = postgresPlan()) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(ExplainPlanDiagram, { nodes });
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
}

function cards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-plan-node]")];
}

function cardFor(operator: string): HTMLElement {
  const card = cards().find((element) => element.textContent?.includes(operator));
  if (!card) throw new Error(`No card rendered for ${operator}`);
  return card;
}

function inspectorText(): string {
  return document.querySelector("aside")?.textContent ?? "";
}

describe("ExplainPlanDiagram", () => {
  it("renders one card per plan node and one edge per parent-child link", async () => {
    await mountDiagram();

    expect(cards()).toHaveLength(6);
    expect(document.querySelectorAll("[data-plan-edges] path")).toHaveLength(5);
    expect(document.querySelectorAll("[data-plan-edges] text")).toHaveLength(5);
  });

  it("shows the cost share badge on nodes with a numeric cost", async () => {
    await mountDiagram();

    // Self-cost of the sequential scan is 18000 of the plan's 24180.37 total.
    expect(cardFor("Seq Scan").textContent).toContain("74.4%");
    expect(cardFor("Seq Scan").textContent).toContain("orders");
    expect(cardFor("Index Scan").textContent).toContain("idx_customers_region");
  });

  it("omits the cost badge when the engine reports no cost", async () => {
    await mountDiagram([planNode({ id: "0", nodeType: "Plan", details: ["explain plan text"] })]);

    expect(cards()).toHaveLength(1);
    expect(cards()[0].textContent).not.toContain("%");
  });

  it("flags a node whose actual rows are at least twice the estimate", async () => {
    await mountDiagram();

    expect(cardFor("Sort").textContent).toContain("×2.0");
    expect(cardFor("Index Scan").textContent).not.toContain("×");
  });

  it("preselects the costliest node and follows a click to another card", async () => {
    await mountDiagram();

    expect(inspectorText()).toContain("Seq Scan");
    expect(inspectorText()).toContain("Table scan");
    expect(inspectorText()).toContain("created_at >= '2026-01-01'");

    cardFor("Index Scan").click();
    await nextTick();

    expect(inspectorText()).toContain("Index Scan");
    expect(inspectorText()).toContain("Index scan");
    expect(inspectorText()).toContain("idx_customers_region");
    expect(inspectorText()).not.toContain("Table scan");
  });

  it("flags the mismatch on a plan parsed from real EXPLAIN ANALYZE output", async () => {
    const analyzePlan = [
      {
        Plan: {
          "Node Type": "Sort",
          "Startup Cost": 24000.0,
          "Total Cost": 24102.11,
          "Plan Rows": 42000,
          "Actual Rows": 96000,
          "Actual Loops": 1,
          "Actual Startup Time": 812.44,
          "Actual Total Time": 851.09,
          Plans: [{ "Node Type": "Seq Scan", "Relation Name": "orders", "Startup Cost": 0.0, "Total Cost": 18000.0, "Plan Rows": 1200000, "Actual Rows": 1187423, "Actual Loops": 1 }],
        },
        "Planning Time": 0.482,
        "Execution Time": 862.104,
      },
    ];
    const result: QueryResult = { columns: ["QUERY PLAN"], rows: [[JSON.stringify(analyzePlan)]], affected_rows: 0, execution_time_ms: 1 };

    await mountDiagram(parseExplainResult("postgres", result).nodes);

    // 96000 measured against 42000 estimated is a 2.3x overrun.
    expect(cardFor("Sort").textContent).toContain("×2.3");
    // The scan landed within 1% of its estimate, so it stays unflagged.
    expect(cardFor("Seq Scan").textContent).not.toContain("×");

    // Planning/Execution time live on the root node, which is not the costliest one.
    cardFor("Sort").click();
    await nextTick();
    expect(inspectorText()).toContain("Planning Time");
    expect(inspectorText()).toContain("862.104 ms");
  });

  // Detail strings mirror what parseSqlServerRelOp emits for SET STATISTICS XML;
  // see lib/__tests__/query/sqlserverActualPlan.spec.ts for the parser contract.
  it("does not flag a SQL Server node whose cumulative rows only look like an overrun", async () => {
    await mountDiagram([
      planNode({
        id: "0",
        nodeType: "Nested Loops",
        cost: "1.2",
        rows: "1000",
        details: ["Actual Rows: 1000", "Actual Threads: 3", "Actual Executions: 3"],
        children: [
          planNode({
            id: "1",
            nodeType: "Index Seek",
            relation: "dbo.orders",
            cost: "0.85",
            rows: "10",
            // 1000 cumulative rows over 100 executions is 10 per execution, exactly
            // the estimate. Comparing the raw total would report a bogus x100.
            details: ["Actual Rows: 1000", "Actual Threads: 3", "Actual Executions: 100", "Actual Rows Per Execution: 10"],
          }),
        ],
      }),
    ]);

    expect(cardFor("Index Seek").textContent).not.toContain("×");
    expect(cardFor("Nested Loops").textContent).not.toContain("×");
  });

  it("still flags a SQL Server node that misestimates per execution", async () => {
    await mountDiagram([
      planNode({
        id: "0",
        nodeType: "Index Seek",
        relation: "dbo.orders",
        cost: "0.85",
        rows: "10",
        details: ["Actual Rows: 5000", "Actual Executions: 100", "Actual Rows Per Execution: 50"],
      }),
    ]);

    expect(cardFor("Index Seek").textContent).toContain("×5.0");
  });

  it("keeps the zoom controls inside their range", async () => {
    await mountDiagram();

    const zoomOut = document.querySelector<HTMLButtonElement>('button[aria-label="Zoom out"]');
    const zoomIn = document.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]');
    expect(zoomOut && zoomIn).toBeTruthy();
    expect(document.body.textContent).toContain("100%");

    for (let step = 0; step < 10; step += 1) zoomOut?.click();
    await nextTick();
    expect(document.body.textContent).toContain("50%");

    for (let step = 0; step < 20; step += 1) zoomIn?.click();
    await nextTick();
    expect(document.body.textContent).toContain("160%");
  });
});
