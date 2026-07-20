import { afterEach, describe, expect, it, vi } from "vitest";
import { generateId } from "@/lib/ai/aiConfigList";

describe("generateId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses crypto.randomUUID when available", () => {
    const randomUUID = vi.fn(() => "123e4567-e89b-42d3-a456-426614174000");
    vi.stubGlobal("crypto", { randomUUID });

    expect(generateId()).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("generates an id when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});
    vi.spyOn(Math, "random").mockReturnValue(0);

    expect(generateId()).toBe("00000000-0000-4000-8000-000000000000");
  });
});
