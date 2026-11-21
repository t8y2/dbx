import { describe, expect, it } from "vitest";
import { CONNECTION_PICKER_OPTIONS, CONNECTION_PROFILES } from "@/types/generated/connectionProfiles";

describe("etcd connection dialog API versions", () => {
  it("hydrates the v2 profile without exposing a second catalog entry", () => {
    expect(CONNECTION_PROFILES["etcd-v2"]).toMatchObject({ type: "etcd", port: 2379 });
    expect(CONNECTION_PICKER_OPTIONS.some((option) => option.value === "etcd-v2")).toBe(false);
  });
});
