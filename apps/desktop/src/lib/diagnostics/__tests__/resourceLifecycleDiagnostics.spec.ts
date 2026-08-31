import { beforeEach, describe, expect, it } from "vitest";

import { resourceLifecycleDiagnostics } from "@/lib/diagnostics/resourceLifecycleDiagnostics";
import { clearMetadataRuntimeCache, setMetadataRuntimeCache } from "@/lib/metadata/metadataRuntimeCache";

describe("resourceLifecycleDiagnostics", () => {
  beforeEach(() => {
    clearMetadataRuntimeCache();
  });

  it("includes metadata cache diagnostics in the existing lifecycle snapshot", () => {
    setMetadataRuntimeCache("metadata-key", { value: 1 }, "connection-1");

    const diagnostics = resourceLifecycleDiagnostics([]);

    expect(diagnostics.metadataCache.entries).toBe(1);
    expect(diagnostics.metadataCache.bytes).toBeGreaterThan(0);
  });
});
