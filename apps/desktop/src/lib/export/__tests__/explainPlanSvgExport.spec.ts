import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import type { ExplainPlanNode } from "@/lib/diagram/explainPlan";
import { buildPlanCanvas } from "@/lib/diagram/planCanvas";
import { buildExplainPlanSvg } from "../explainPlanSvgExport";

function planNode(node: Partial<ExplainPlanNode> & { id: string; nodeType: string }): ExplainPlanNode {
  return { title: node.nodeType, details: [], children: [], ...node };
}

function fixture(): ExplainPlanNode[] {
  return [
    planNode({
      id: "0",
      nodeType: "SELECT <STATEMENT>",
      title: "SELECT <STATEMENT>",
      cost: "148 (0)",
      rows: "10",
      children: [
        planNode({
          id: "1",
          nodeType: "INDEX RANGE SCAN",
          relation: "users & roles",
          index: 'IDX_"USERS"',
          cost: "0.29..1830.12",
          rows: "96M",
          details: ["Predicate: name = 'A&B'"],
        }),
      ],
    }),
    planNode({ id: "0", nodeType: "SECOND ROOT", cost: "2", rows: "1" }),
  ];
}

const labels = {
  title: "Explain Plan · ORACLE",
  cost: "Cost",
  estimatedRows: "Estimated rows",
  legendHeat: "Cost heat",
  legendEdge: "Edge thickness = estimated rows",
};

describe("buildExplainPlanSvg", () => {
  it("renders every root, child and edge into a standalone SVG", () => {
    const nodes = fixture();
    const layout = buildPlanCanvas(nodes);
    const svg = buildExplainPlanSvg(nodes, labels);
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = document.documentElement;

    expect(root.tagName).toBe("svg");
    expect(root.getAttribute("xmlns")).toBe("http://www.w3.org/2000/svg");
    expect(Number(root.getAttribute("width"))).toBeGreaterThanOrEqual(layout.width);
    expect(Number(root.getAttribute("height"))).toBeGreaterThan(layout.height);
    expect(document.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(svg.match(/class="plan-node"/g)).toHaveLength(3);
    expect(svg.match(/<path d="M .* H .* V .* H /g)).toHaveLength(1);
    expect(svg).toContain("Explain Plan · ORACLE");
    expect(svg).toContain("Estimated rows");
    expect(svg).toContain("Edge thickness = estimated rows");
  });

  it("escapes engine text and uses only rasterizable SVG primitives", () => {
    const svg = buildExplainPlanSvg(fixture(), labels);

    expect(svg).toContain("SELECT &lt;STATEMENT&gt;");
    expect(svg).toContain("users &amp; roles");
    expect(svg).toContain("IDX_&quot;USERS&quot;");
    expect(svg).toContain("A&amp;B");
    expect(svg).not.toContain("<foreignObject");
    expect(svg).not.toContain("var(--");
  });

  it("preserves engine-native values in node tooltips", () => {
    const svg = buildExplainPlanSvg(fixture(), labels);

    expect(svg).toContain("148 (0)");
    expect(svg).toContain("0.29..1830.12");
    expect(svg).toContain("96M");
    expect(svg).toContain("Predicate: name = &apos;A&amp;B&apos;");
  });
});
