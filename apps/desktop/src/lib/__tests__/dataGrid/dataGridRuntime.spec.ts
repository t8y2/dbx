import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDataGridRuntimeScope } from "@/lib/dataGrid/dataGridRuntime";

describe("dataGridRuntime", () => {
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
    const sourceRoots = [join(process.cwd(), "apps/desktop/src/lib/dataGrid"), join(process.cwd(), "apps/desktop/src/composables")];
    const sourceFiles: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.name.endsWith(".ts") && (!directory.endsWith("/composables") || entry.name.startsWith("useDataGrid"))) sourceFiles.push(path);
      }
    };
    sourceRoots.forEach(visit);

    expect(sourceFiles.filter((path) => readFileSync(path, "utf8").includes("DataGrid.vue"))).toEqual([]);
  });
});
