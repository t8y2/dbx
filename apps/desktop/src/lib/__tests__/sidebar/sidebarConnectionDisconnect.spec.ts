import { describe, expect, it, vi } from "vitest";
import { disconnectSidebarConnections } from "@/lib/sidebar/sidebarConnectionDisconnect";

describe("sidebar connection disconnect", () => {
  it("attempts every connection and reports success", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);

    const result = await disconnectSidebarConnections(["conn-1", "conn-2"], disconnect);

    expect(disconnect.mock.calls).toEqual([["conn-1"], ["conn-2"]]);
    expect(result).toEqual({ succeeded: 2, failed: 0, firstError: undefined });
  });

  it("continues after a failure and retains the first error", async () => {
    const firstError = new Error("first failed");
    const disconnect = vi.fn().mockRejectedValueOnce(firstError).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("last failed"));

    const result = await disconnectSidebarConnections(["conn-1", "conn-2", "conn-3"], disconnect);

    expect(disconnect).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ succeeded: 1, failed: 2, firstError });
  });
});
