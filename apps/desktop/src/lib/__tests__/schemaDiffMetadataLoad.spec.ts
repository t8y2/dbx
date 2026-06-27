import { describe, expect, it } from "vitest";
import { createConcurrencyLimiter, mapWithConcurrency, schemaDiffMetadataConcurrency } from "@/lib/schemaDiffMetadataLoad";

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe("schemaDiffMetadataLoad", () => {
  it("uses adaptive metadata concurrency for MySQL-compatible databases", () => {
    expect(schemaDiffMetadataConcurrency("mysql")).toBe(2);
    expect(schemaDiffMetadataConcurrency("MariaDB")).toBe(2);
    expect(schemaDiffMetadataConcurrency("mysql", 30)).toBe(4);
    expect(schemaDiffMetadataConcurrency("mysql", 31)).toBe(2);
    expect(schemaDiffMetadataConcurrency("MariaDB", 12)).toBe(4);
    expect(schemaDiffMetadataConcurrency("postgres")).toBe(6);
    expect(schemaDiffMetadataConcurrency("postgres", 100)).toBe(6);
    expect(schemaDiffMetadataConcurrency(undefined)).toBe(6);
  });

  it("maps items with limited concurrency and preserves output order", async () => {
    let active = 0;
    let maxActive = 0;

    const result = await mapWithConcurrency([30, 5, 10, 1], 2, async (delay, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(delay);
      active -= 1;
      return `${index}:${delay}`;
    });

    expect(result).toEqual(["0:30", "1:5", "2:10", "3:1"]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("propagates the first worker error and stops scheduling new work", async () => {
    const started: number[] = [];

    await expect(
      mapWithConcurrency([1, 2, 3], 1, async (item) => {
        started.push(item);
        if (item === 2) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");

    expect(started).toEqual([1, 2]);
  });

  it("limits arbitrary async tasks", async () => {
    const runLimited = createConcurrencyLimiter(2);
    let active = 0;
    let maxActive = 0;

    const result = await Promise.all(
      [8, 6, 4, 2].map((delay, index) =>
        runLimited(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await wait(delay);
          active -= 1;
          return index;
        }),
      ),
    );

    expect(result).toEqual([0, 1, 2, 3]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
