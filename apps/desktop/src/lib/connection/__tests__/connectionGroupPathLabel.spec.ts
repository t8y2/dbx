import { describe, expect, it } from "vitest";
import { connectionGroupPathLabel } from "../connectionGroupPathLabel";

const fitsCharacters = (limit: number) => (text: string) => Array.from(text).length <= limit;

describe("connectionGroupPathLabel", () => {
  it("shows the complete compact path when there is room", () => {
    expect(connectionGroupPathLabel(["Prod", "Asia", "Orders"], fitsCharacters(30))).toBe("Prod/Asia/Orders");
  });

  it("keeps complete end groups and fills spare space with more of the middle", () => {
    const path = ["Prod", "Asia", "Reporting", "Team", "Orders"];
    const label = connectionGroupPathLabel(path, fitsCharacters(22));
    expect(label).toHaveLength(22);
    expect(label.startsWith("Prod/")).toBe(true);
    expect(label.endsWith("/Orders")).toBe(true);
    expect(label).toContain("Asia");
    expect(connectionGroupPathLabel(path, fitsCharacters(13))).toBe("Prod/…/Orders");
  });

  it("shortens the middle of long names only when the end groups cannot fit", () => {
    const label = connectionGroupPathLabel(["Production", "Asia", "OrderService"], fitsCharacters(12));
    expect(label.length).toBeLessThanOrEqual(12);
    expect(label).toMatch(/^Pro.*….*ice$/);
  });

  it("handles single groups, two groups and Unicode characters", () => {
    expect(connectionGroupPathLabel(["Production"], fitsCharacters(7))).toBe("Pro…ion");
    expect(connectionGroupPathLabel(["Prod", "Orders"], fitsCharacters(9))).toBe("Prod…ders");
    expect(connectionGroupPathLabel(["😀😀😀😀😀"], fitsCharacters(3))).toBe("😀…😀");
    expect(connectionGroupPathLabel([], fitsCharacters(0))).toBe("");
  });
});
