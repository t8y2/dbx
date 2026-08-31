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

describe("ExplainPlanViewer header at narrow widths", () => {
  it("keeps the title badge and node-count label on one line instead of letting them wrap", () => {
    const headerMatch = viewerSource.match(/<div class="h-9 shrink-0[^"]*"[^>]*>([\s\S]*?)<\/div>\s*\n\s*<div v-if="loading/);
    expect(headerMatch, "explain plan header block not found").not.toBeNull();
    const header = headerMatch![0];
    expect(header).toContain("overflow-x-auto");
    // Title badge and "MYSQL · N nodes" label must not be flex-shrinkable, or a
    // narrow host (e.g. the AI chat panel) squeezes their text into a
    // near-zero width and the browser wraps it one character per line.
    expect(header).toMatch(/<span class="shrink-0 whitespace-nowrap inline-flex[^"]*">\s*<GitBranch/);
    expect(header).toMatch(/<span v-if="plan \|\| hasTableView" class="shrink-0 whitespace-nowrap text-muted-foreground">/);
  });

  it("keeps the view-switcher button group from shrinking away", () => {
    expect(viewerSource).toContain('<div v-if="plan || hasTableView" class="shrink-0 inline-flex rounded-md border bg-muted/40 p-0.5">');
  });
});
