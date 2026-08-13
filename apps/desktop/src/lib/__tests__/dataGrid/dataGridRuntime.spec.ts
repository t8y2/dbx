import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDataGridRuntimeScope } from "@/lib/dataGrid/dataGridRuntime";

const dataGridSource = readFileSync(new URL("../../../components/grid/DataGrid.vue", import.meta.url), "utf8");

function extractFunction(name: string): string {
  const start = dataGridSource.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`Missing DataGrid function: ${name}`);
  const bodyStart = dataGridSource.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < dataGridSource.length; index++) {
    const character = dataGridSource[index];
    if (character === "{") depth++;
    if (character === "}" && --depth === 0) return dataGridSource.slice(start, index + 1);
  }
  throw new Error(`Unterminated DataGrid function: ${name}`);
}

describe("dataGridRuntime", () => {
  it("keeps WHERE and ORDER BY execution errors separate from save errors", () => {
    for (const name of ["applyWhereFilter", "applyOrderBySearch"]) {
      const source = extractFunction(name);
      expect(source).toContain('queryControlError.value = ""');
      expect(source).toContain("queryControlError.value = String(e?.message || e)");
      expect(source).not.toContain("saveError.value");
    }
    expect(dataGridSource).toContain('v-if="queryControlError"');
    expect(dataGridSource).toContain(":title=\"t('grid.queryError')\"");
  });

  it("redraws canvas rows when multiline flattening changes", () => {
    expect(dataGridSource).toContain("watch(flatteningMultiLineEnabled, () => scheduleCanvasDraw());");
  });

  it("disposes registered resources in reverse order and only once", () => {
    const scope = createDataGridRuntimeScope();
    const calls: string[] = [];
    const removeFirst = scope.addCleanup(() => calls.push("first"));
    scope.addCleanup(() => calls.push("second"));

    removeFirst();
    scope.dispose();
    scope.dispose();

    expect(calls).toEqual(["second"]);
    expect(scope.disposed).toBe(true);
  });

  it("runs cleanup immediately when registered after disposal", () => {
    const scope = createDataGridRuntimeScope();
    const cleanup = vi.fn();

    scope.dispose();
    const unregister = scope.addCleanup(cleanup);

    unregister();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("keeps runtime modules independent from the DataGrid component", () => {
    const repoRoot = process.cwd().replace(/[\\/]apps[\\/]desktop$/, "");
    const sourceRoots = [join(repoRoot, "apps/desktop/src/lib/dataGrid"), join(repoRoot, "apps/desktop/src/composables")];
    const sourceFiles: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.name.endsWith(".ts") && (!directory.endsWith("composables") || entry.name.startsWith("useDataGrid"))) sourceFiles.push(path);
      }
    };
    sourceRoots.forEach(visit);

    expect(sourceFiles.filter((path) => readFileSync(path, "utf8").includes("DataGrid.vue"))).toEqual([]);
  });
});
