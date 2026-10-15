import { describe, expect, it } from "vitest";
import { isProtectionPasswordFeatureActive } from "@/lib/sidebar/protectionPassword";

// Password hashing and verification moved to the Rust backend
// (`dbx-core::persistence::protection_password`); the frontend keeps only the
// web/desktop feature gate. The verifier itself is never sent to clients
// anymore, so there is nothing left to unit-test on this side beyond the gate.
describe("isProtectionPasswordFeatureActive", () => {
  it("is active in a plain web environment", () => {
    expect(isProtectionPasswordFeatureActive()).toBe(true);
  });

  it("is inactive under a Tauri runtime", () => {
    // `isTauriRuntime` reads `globalThis.__TAURI_INTERNALS__`, so patch the
    // real global (vitest's stubGlobal may target the DOM window instead).
    const globals = globalThis as Record<string, unknown>;
    const previous = globals.__TAURI_INTERNALS__;
    globals.__TAURI_INTERNALS__ = {};
    try {
      expect(isProtectionPasswordFeatureActive()).toBe(false);
    } finally {
      globals.__TAURI_INTERNALS__ = previous;
    }
  });
});
