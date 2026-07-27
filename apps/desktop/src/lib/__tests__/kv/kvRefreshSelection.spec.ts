import { describe, expect, it } from "vitest";
import { refreshedKvSelectionSummary } from "@/lib/kv/kvRefreshSelection";
import type { KvKeySummary } from "@/lib/backend/api";

describe("kv refresh selection", () => {
  const keys: KvKeySummary[] = [{ key: "/app/config" }, { key: "/app/feature" }];

  it("keeps the previously selected key when it still exists after refresh", () => {
    expect(refreshedKvSelectionSummary("/app/config", keys)).toEqual({ key: "/app/config" });
  });

  it("clears the selected key when it no longer exists after refresh", () => {
    expect(refreshedKvSelectionSummary("/app/missing", keys)).toBeNull();
  });

  it("does not switch to a colliding display key when the selected byte identity disappears", () => {
    const collision: KvKeySummary[] = [{ key: "[base64:/w==]", keyIdentity: "5b6261736536343a2f773d3d5d" }];

    expect(refreshedKvSelectionSummary("ff", collision)).toBeNull();
    expect(refreshedKvSelectionSummary("5b6261736536343a2f773d3d5d", collision)).toEqual(collision[0]);
  });
});
