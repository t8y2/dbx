import { describe, expect, it } from "vitest";
import { CONNECTION_PICKER_OPTIONS, CONNECTION_PROFILES } from "@/types/generated/connectionProfiles";

describe("H2 connection dialog driver profiles", () => {
  it("keeps legacy profile hydration without exposing a second H2 catalog entry", () => {
    expect(CONNECTION_PROFILES["h2-legacy"]).toMatchObject({ type: "h2", port: 9092, user: "sa" });
    expect(CONNECTION_PICKER_OPTIONS.find((option) => option.value === "h2")?.category).toBe("lightweight");
    expect(CONNECTION_PICKER_OPTIONS.some((option) => option.value === "h2-legacy")).toBe(false);
  });
});
