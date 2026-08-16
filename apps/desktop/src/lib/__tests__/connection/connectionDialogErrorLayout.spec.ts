import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("connection dialog error layout", () => {
  it("installs a required agent before running a connection test", () => {
    const installIndex = dialogSource.indexOf("await ensureRequiredAgentDriverInstalled(config);");
    const testIndex = dialogSource.indexOf("const result = await testConnectionWithTimeout(config, runId);");

    expect(installIndex).toBeGreaterThan(-1);
    expect(testIndex).toBeGreaterThan(installIndex);
  });

  it("wraps long connection and driver installation errors inside the dialog", () => {
    const wrappingClasses = "min-w-0 max-w-full overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-all [overflow-wrap:anywhere]";

    expect(dialogSource.split(wrappingClasses)).toHaveLength(3);
    expect(dialogSource).toContain('<DialogContent class="min-w-0 sm:max-w-[680px]">');
  });
});
