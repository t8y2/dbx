import { describe, expect, it } from "vitest";
import { REDIS_CREATE_KEY_TYPE_VALUES, getRedisCreateKeyTypeHelp, redisCreateKeyTypeHelpOptionOnOpen, shouldActivateRedisCreateKeyTypeHelpOnFocus } from "@/lib/redis/redisCreateKeyTypeHelp";
import en from "@/i18n/locales/en";
import zhCN from "@/i18n/locales/zh-CN";

function redisCreateTypeHelpMessages(locale: unknown): Record<string, unknown> {
  const messages = locale as { redis?: { createKeyTypeHelp?: Record<string, unknown> } };
  return messages.redis?.createKeyTypeHelp ?? {};
}

describe("getRedisCreateKeyTypeHelp", () => {
  it("covers every key type offered by the Create key dialog", () => {
    for (const type of REDIS_CREATE_KEY_TYPE_VALUES) {
      expect(getRedisCreateKeyTypeHelp(type)).toEqual({ key: type });
    }
  });

  it("normalizes casing and leaves unsupported types undocumented", () => {
    expect(getRedisCreateKeyTypeHelp(" ZSET ")).toEqual({ key: "zset" });
    expect(getRedisCreateKeyTypeHelp("bitmap")).toBeUndefined();
  });

  it("activates help only for focus reached through Arrow navigation", () => {
    expect(shouldActivateRedisCreateKeyTypeHelpOnFocus({ openedByArrow: true, keyboardNavigating: true })).toBe(true);
    expect(shouldActivateRedisCreateKeyTypeHelpOnFocus({ openedByArrow: false, keyboardNavigating: true })).toBe(true);
    expect(shouldActivateRedisCreateKeyTypeHelpOnFocus({ openedByArrow: false, keyboardNavigating: false })).toBe(false);
  });

  it("shows the selected offered type's help when the Select opens", () => {
    expect(redisCreateKeyTypeHelpOptionOnOpen("string")).toBe("string");
    expect(redisCreateKeyTypeHelpOptionOnOpen(" JSON ")).toBe("json");
    expect(redisCreateKeyTypeHelpOptionOnOpen("bitmap")).toBeUndefined();
  });

  it("has English and Simplified Chinese copy for every offered type", () => {
    const english = redisCreateTypeHelpMessages(en);
    const chinese = redisCreateTypeHelpMessages(zhCN);

    for (const type of REDIS_CREATE_KEY_TYPE_VALUES) {
      expect(english[type], `English: ${type}`).toEqual(expect.any(String));
      expect(chinese[type], `Simplified Chinese: ${type}`).toEqual(expect.any(String));
    }
  });
});
