import { describe, expect, it, vi } from "vitest";
import { shareObjectBrowserRead } from "../objectBrowserPendingReads";

describe("browser pending reads", () => {
  it("coalesces a generation but separates new generations and modes", async () => {
    let release!: (value: number) => void;
    const read = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    const first = shareObjectBrowserRead("scope:1:light", read);
    expect(shareObjectBrowserRead("scope:1:light", read)).toBe(first);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    expect(await shareObjectBrowserRead("scope:2:light", async () => 2)).toBe(2);
    expect(await shareObjectBrowserRead("scope:1:full", async () => 3)).toBe(3);
    release(1);
    expect(await first).toBe(1);
  });
  it("retries after rejection", async () => {
    await expect(
      shareObjectBrowserRead("failure", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(await shareObjectBrowserRead("failure", async () => 4)).toBe(4);
  });
});
