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
});
