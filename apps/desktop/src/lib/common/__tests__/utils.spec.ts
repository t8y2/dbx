import { afterEach, describe, expect, it, vi } from "vitest";
import { uuid } from "@/lib/common/utils";

describe("uuid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses crypto.randomUUID when available", () => {
    const randomUUID = vi.fn(() => "123e4567-e89b-42d3-a456-426614174000");
    vi.stubGlobal("crypto", { randomUUID });

    expect(uuid()).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("generates a UUID when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});

    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("keeps working without crypto.randomUUID, the state of plain-HTTP deployments", () => {
    // Issue #9306: the Docker build served over HTTP has crypto.getRandomValues but no
    // crypto.randomUUID, and every bare crypto.randomUUID() call threw there.
    const getRandomValues = vi.fn((buffer: Uint8Array) => buffer.fill(0xab));
    vi.stubGlobal("crypto", { getRandomValues });

    expect(uuid()).toBe("abababab-abab-4bab-abab-abababababab");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });
});
