import { describe, expect, it, vi } from "vitest";
import { connectSidebarConnections } from "@/lib/sidebar/sidebarConnectionConnect";

describe("sidebar connection connect", () => {
  it("attempts every connection and reports success", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);

    const result = await connectSidebarConnections(["conn-1", "conn-2"], connect);

    expect(connect.mock.calls).toEqual([["conn-1"], ["conn-2"]]);
    expect(result).toEqual({ succeeded: 2, failed: 0, firstError: undefined });
  });

  it("continues after a failure and retains the first error", async () => {
    const firstError = new Error("first connect failed");
    const connect = vi.fn().mockRejectedValueOnce(firstError).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("last failed"));

    const result = await connectSidebarConnections(["conn-1", "conn-2", "conn-3"], connect);

    expect(connect).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ succeeded: 1, failed: 2, firstError });
  });

  it("returns zero counts for empty connection list", async () => {
    const connect = vi.fn();

    const result = await connectSidebarConnections([], connect);

    expect(connect).not.toHaveBeenCalled();
    expect(result).toEqual({ succeeded: 0, failed: 0, firstError: undefined });
  });
});
