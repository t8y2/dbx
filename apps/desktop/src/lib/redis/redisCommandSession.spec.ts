import { describe, expect, it } from "vitest";
import { redisKeyRawToText, redisKeyTextToDisplay, redisKeyTextToRaw } from "./redisCommandSession";

describe("Redis key text encoding", () => {
  it("round-trips UTF-8 keys without treating backslashes as display escapes", () => {
    const key = "cache\\session";
    const raw = redisKeyTextToRaw(key);

    expect(redisKeyRawToText(raw)).toBe(key);
    expect(redisKeyTextToDisplay(key)).toBe("cache\\\\session");
  });

  it("does not coerce binary key bytes into a text key name", () => {
    expect(redisKeyRawToText("/w==")).toBeNull();
  });
});
