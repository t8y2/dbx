import { describe, expect, it } from "vitest";
import { navigationEntryKey } from "../navigationEntry";

describe("navigation entry keys", () => {
  it("does not confuse delimiters within adjacent object identity fields", () => {
    const base = { id: "", surface: "query" as const };
    expect(navigationEntryKey({ ...base, objectSignature: "a|b", mode: "c" })).not.toBe(navigationEntryKey({ ...base, objectSignature: "a", mode: "b|c" }));
  });
});
