import { describe, expect, it } from "vitest";
import { parseMongoJson } from "../mongoJson";

describe("Mongo JSON numeric input safety", () => {
  it("keeps canonical wrappers and ordinary JSON values", () => {
    expect(parseMongoJson('{"n":{"$numberLong":"9223372036854775807"},"v":0.5,"text":"9007199254740993"}')).toEqual({
      n: { $numberLong: "9223372036854775807" },
      v: 0.5,
      text: "9007199254740993",
    });
  });
  it("rejects rounded integers, infinities, negative zero and excessive input", () => {
    for (const text of ['{"n":9007199254740993}', "[1e999]", "[9007199254740992]", "[-0]", "[-0.0]", " ".repeat(2 * 1024 * 1024 + 1)]) expect(() => parseMongoJson(text)).toThrow();
  });
});
