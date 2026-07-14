import { describe, expect, test } from "vitest";
import { createLatestRequestGuard } from "../../apps/desktop/src/lib/app/changelog";

describe("latest changelog request guard", () => {
  test("invalidates older requests when a new load starts", () => {
    const guard = createLatestRequestGuard();
    const englishRequest = guard.begin();
    const chineseRequest = guard.begin();

    expect(guard.isCurrent(englishRequest)).toBe(false);
    expect(guard.isCurrent(chineseRequest)).toBe(true);
  });
});
