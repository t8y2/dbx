import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPluginWorkbenchNativeFileTargetsForTests, forwardActivePluginNativeFileDrag, registerPluginWorkbenchNativeFileTarget } from "./pluginWorkbenchBridgeRegistry";

describe("plugin workbench native file routing", () => {
  beforeEach(clearPluginWorkbenchNativeFileTargetsForTests);

  it("routes a drop only to the active workbench", async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    registerPluginWorkbenchNativeFileTarget("first", { acceptsNativeFileDrag: () => true, forwardNativeFileDrag: first });
    registerPluginWorkbenchNativeFileTarget("second", { acceptsNativeFileDrag: () => true, forwardNativeFileDrag: second });

    expect(await forwardActivePluginNativeFileDrag("second", "drop", ["selected.bin"])).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("drop", ["selected.bin"]);
  });

  it("falls through when the active tab is not an eligible plugin workbench", async () => {
    registerPluginWorkbenchNativeFileTarget("plugin", { acceptsNativeFileDrag: () => false, forwardNativeFileDrag: vi.fn() });
    expect(await forwardActivePluginNativeFileDrag("plugin", "drop", ["query.sql"])).toBe(false);
    expect(await forwardActivePluginNativeFileDrag("query", "drop", ["query.sql"])).toBe(false);
  });
});
