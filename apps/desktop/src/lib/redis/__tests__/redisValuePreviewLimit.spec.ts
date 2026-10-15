import { describe, expect, it } from "vitest";
import { normalizeRedisValuePreviewLimitKiB, redisValuePreviewLimitBytes } from "../redisValuePreviewLimit";
import { DEFAULT_EDITOR_SETTINGS, normalizeEditorSettings } from "@/stores/settingsStore";

describe("Redis value preview setting", () => {
  it("preserves the 64 KiB default for existing settings", () => {
    expect(DEFAULT_EDITOR_SETTINGS.redisValuePreviewLimitKiB).toBe(64);
    expect(normalizeEditorSettings({}).redisValuePreviewLimitKiB).toBe(64);
    expect(redisValuePreviewLimitBytes(undefined)).toBe(65536);
  });

  it.each([undefined, "256", NaN, Infinity, -Infinity])("uses the default for invalid saved values %s", (value) => {
    expect(normalizeRedisValuePreviewLimitKiB(value)).toBe(64);
  });

  it.each([
    [0, 1],
    [-2, 1],
    [256.4, 256],
    [256.7, 257],
    [65536, 65536],
    [100000, 65536],
  ])("normalizes %s KiB to %s", (value, expected) => {
    expect(normalizeEditorSettings({ redisValuePreviewLimitKiB: value }).redisValuePreviewLimitKiB).toBe(expected);
    expect(redisValuePreviewLimitBytes(value)).toBe(expected * 1024);
  });
});
