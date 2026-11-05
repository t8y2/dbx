import { describe, expect, it } from "vitest";
import { gbaseProfileFromConfig, isGbaseProfile } from "@/lib/connection/gbaseProfiles";

describe("gbaseProfiles", () => {
  it("recognizes the three GBase toggle profiles", () => {
    expect(["gbase8a", "gbase8s", "gbase8c"].every(isGbaseProfile)).toBe(true);
    expect(isGbaseProfile("gbase")).toBe(false);
    expect(isGbaseProfile(undefined)).toBe(false);
  });

  it("resolves the toggle profile from a saved connection", () => {
    expect(gbaseProfileFromConfig({ db_type: "gbase8c", driver_profile: "gbase8c" })).toBe("gbase8c");
    expect(gbaseProfileFromConfig({ db_type: "gbase8c" })).toBe("gbase8c");
    expect(gbaseProfileFromConfig({ db_type: "gbase8s", driver_profile: "gbase8s" })).toBe("gbase8s");
    expect(gbaseProfileFromConfig({ db_type: "gbase8s" })).toBe("gbase8s");
    // A not-yet-migrated in-memory config still resolves to the 8s toggle.
    expect(gbaseProfileFromConfig({ db_type: "gbase", driver_profile: "gbase8s" })).toBe("gbase8s");
    expect(gbaseProfileFromConfig({ db_type: "gbase", driver_profile: "gbase8a" })).toBe("gbase8a");
    expect(gbaseProfileFromConfig({ db_type: "gbase", driver_profile: "gbase" })).toBe("gbase8a");
    expect(gbaseProfileFromConfig({ db_type: "gbase" })).toBe("gbase8a");
  });
});
