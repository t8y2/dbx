import { describe, expect, it } from "vitest";
import { CONNECTION_PICKER_OPTIONS, CONNECTION_PROFILES } from "@/types/generated/connectionProfiles";

describe("Cloud Spanner connection dialog", () => {
  it("registers the bundled agent profile in the SQL category", () => {
    expect(CONNECTION_PROFILES.spanner).toMatchObject({ type: "spanner", port: 443, user: "", label: "Cloud Spanner", icon: "spanner" });
    expect(CONNECTION_PICKER_OPTIONS.find((option) => option.value === "spanner")).toEqual({ value: "spanner", label: "Cloud Spanner", category: "sql" });
  });
});
