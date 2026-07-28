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

  it("keeps the regular tree default when the visual plan arrives", () => {
    expect(viewerSource).toContain('if (!loading && hasTableResult && !hasPlan) activeView.value = "table";');
    expect(viewerSource).toContain('if (!available && activeView.value === "table") activeView.value = "tree";');
  });
});
