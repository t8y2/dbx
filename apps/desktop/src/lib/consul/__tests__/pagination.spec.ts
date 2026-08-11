import { describe, expect, it } from "vitest";
import { clampConsulPage, consulPageCount, paginateConsulItems } from "@/lib/consul/pagination";

describe("Consul list pagination", () => {
  it("splits large result sets without dropping the final partial page", () => {
    const items = Array.from({ length: 123 }, (_, index) => index + 1);
    expect(consulPageCount(items.length, 50)).toBe(3);
    expect(paginateConsulItems(items, 1, 50)).toEqual(items.slice(0, 50));
    expect(paginateConsulItems(items, 3, 50)).toEqual(items.slice(100));
  });

  it("clamps stale pages after filtering or deletion", () => {
    expect(clampConsulPage(9, 51, 50)).toBe(2);
    expect(clampConsulPage(0, 51, 50)).toBe(1);
    expect(clampConsulPage(Number.NaN, 0, 50)).toBe(1);
  });
});
