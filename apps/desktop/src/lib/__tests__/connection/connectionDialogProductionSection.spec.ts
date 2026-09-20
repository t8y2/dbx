import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("ConnectionDialog production protection section", () => {
  it("hides the production protection section for plugin connections", () => {
    expect(dialogSource).toContain('<div v-if="!isPluginConnection" class="grid grid-cols-4 items-start gap-4 rounded-[6px] border border-red-500/25 bg-red-500/[0.035] px-3 py-2.5">');
  });

  it("clears stale production flags when submitting plugin connections", () => {
    const submitFn = dialogSource.slice(dialogSource.indexOf("function connectionConfigForSubmit"));
    const pluginBranch = submitFn.slice(0, submitFn.indexOf("} else {"));
    expect(pluginBranch).toContain("config.is_production = false;");
    expect(pluginBranch).toContain("config.production_databases = [];");
    expect(pluginBranch).not.toContain("config.is_production = form.value.is_production;");
  });
});
