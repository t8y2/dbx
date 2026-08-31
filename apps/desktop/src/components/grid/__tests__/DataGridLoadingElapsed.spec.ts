import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid loading elapsed timer", () => {
  it("resets for a new load but resumes from the original start after KeepAlive activation", () => {
    expect(dataGridSource).toContain("function startLoadingElapsedTimer(reset = false)");
    expect(dataGridSource).toContain("if (reset || !_loadingStart)");
    expect(dataGridSource).toContain("startLoadingElapsedTimer(true);");
    expect(dataGridSource).toMatch(/function resumeCanvasGridWork\(\) \{\s*dataGridIsActive = true;\s*startLoadingElapsedTimer\(\);/);
    expect(dataGridSource).toMatch(/function pauseCanvasGridWork\(\) \{\s*dataGridIsActive = false;\s*stopLoadingElapsedTimer\(\);/);
  });
});
