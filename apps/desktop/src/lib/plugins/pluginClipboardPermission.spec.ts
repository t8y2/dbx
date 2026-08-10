import { afterEach, describe, expect, it, vi } from "vitest";
import { requestPluginClipboardReadGrant, resetPluginClipboardReadGrantsForTests } from "./pluginClipboardPermission";

describe("plugin clipboard read grants", () => {
  afterEach(() => {
    resetPluginClipboardReadGrantsForTests();
    vi.unstubAllGlobals();
  });

  it("asks once per plugin for the current process after approval", async () => {
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirm);
    await expect(requestPluginClipboardReadGrant("one", "One")).resolves.toBe(true);
    await expect(requestPluginClipboardReadGrant("one", "One")).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("does not read after a refusal and asks again on a later request", async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirm);
    await expect(requestPluginClipboardReadGrant("one", "One")).resolves.toBe(false);
    await expect(requestPluginClipboardReadGrant("one", "One")).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
