import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const viewerSource = readFileSync(new URL("../ExplainPlanViewer.vue", import.meta.url), "utf8");

describe("ExplainPlanViewer MySQL fallback", () => {
  it("selects the table only after loading finishes without a visual plan", () => {
    expect(viewerSource).toContain("const hasTableView = computed(() => !!props.tableResult || !!props.tableError);");
    expect(viewerSource).toContain("[hasTableView, () => !!props.tableResult, () => !!props.plan, () => props.loading]");
    expect(viewerSource).toContain('if (!loading && hasTableResult && !hasPlan) activeView.value = "table";');
    expect(viewerSource).toContain("{ immediate: true },");
  });

  it("keeps the canvas default when the visual plan arrives", () => {
    expect(viewerSource).toContain('if (!loading && hasTableResult && !hasPlan) activeView.value = "table";');
    expect(viewerSource).toContain('if (!available && activeView.value === "table") activeView.value = "canvas";');
  });
});

describe("ExplainPlanViewer canvas view", () => {
  it("opens on the canvas and keeps the other views reachable", () => {
    expect(viewerSource).toContain('const activeView = ref<"canvas" | "tree" | "summary" | "raw" | "table">("canvas");');
    expect(viewerSource).toContain('<ExplainPlanDiagram :nodes="plan.nodes" />');
    expect(viewerSource).toContain('import ExplainPlanDiagram from "./ExplainPlanDiagram.vue";');
    for (const view of ["canvas", "tree", "summary", "raw", "table"]) {
      expect(viewerSource, view).toContain(`activeView = '${view}'`);
    }
  });

  it("derives the measured-rows chip from parsed nodes, not the raw plan text", () => {
    expect(viewerSource).toContain('import { extractActualRows } from "@/lib/diagram/planCanvas";');
    expect(viewerSource).toContain("const measuredRowsLabel = computed(() => {");
    expect(viewerSource).toContain('if (databaseType !== "postgres" && databaseType !== "sqlserver") return undefined;');
    expect(viewerSource).toContain("if (!flattenExplainPlanNodes(props.plan!.nodes).some((node) => extractActualRows(node) !== undefined)) return undefined;");
    expect(viewerSource).toContain('return databaseType === "sqlserver" ? "ACTUAL" : "ANALYZE";');
    expect(viewerSource).toContain('<span v-if="measuredRowsLabel"');
    expect(viewerSource).toContain("{{ measuredRowsLabel }}</span>");
    // The Dameng A-TRACE chip keeps its own raw-text condition.
    expect(viewerSource).toContain("plan?.databaseType === 'dameng' && isRawString && rawContent.includes('->')");
  });

  it("puts the canvas tab first in the view switcher", () => {
    const tabOrder = [...viewerSource.matchAll(/@click="activeView = '(\w+)'"/g)].map((match) => match[1]);
    expect(tabOrder).toEqual(["canvas", "tree", "summary", "raw", "table"]);
  });
});
