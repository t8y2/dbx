import { describe, expect, it } from "vitest";
import { refreshedKvSelectionKey } from "@/lib/kvRefreshSelection";
import type { KvKeySummary } from "@/lib/api";

describe("kv refresh selection", () => {
  const keys: KvKeySummary[] = [{ key: "/app/config" }, { key: "/app/feature" }];

  it("keeps the previously selected key when it still exists after refresh", () => {
    expect(refreshedKvSelectionKey("/app/config", keys)).toBe("/app/config");
  });

  it("clears the selected key when it no longer exists after refresh", () => {
    expect(refreshedKvSelectionKey("/app/missing", keys)).toBeNull();
  });
});
