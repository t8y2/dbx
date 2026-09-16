import { describe, expect, it } from "vitest";
import { floatingPanelPlacement } from "@/lib/common/floatingPanelPlacement";

// 面板高度取 ColorSpectrumPicker 的估算值，gap 默认 4，完整放下需要 244
const PANEL_HEIGHT = 240;

function placementAt(triggerTop: number, triggerBottom: number, boundaryTop = 0, boundaryBottom = 800): "top" | "bottom" {
  return floatingPanelPlacement({
    triggerTop,
    triggerBottom,
    panelHeight: PANEL_HEIGHT,
    boundaryTop,
    boundaryBottom,
  });
}

describe("floating panel placement", () => {
  it("pops downward when the space below fits the panel", () => {
    // 下方剩余 320，大于 252 + 4
    expect(placementAt(100, 124)).toBe("bottom");
  });

  it("keeps popping downward when the space below exactly equals panel plus gap", () => {
    // 下方刚好 244 = 240 + 4，边界值应向下
    expect(placementAt(544, 568, 0, 812)).toBe("bottom");
  });

  it("flips upward when below is too tight but above fits", () => {
    // 下方 216 不够，上方 560 足够
    expect(placementAt(560, 584)).toBe("top");
  });

  it("flips upward when the space above exactly equals panel plus gap", () => {
    // 上方刚好 244 = 240 + 4，边界值应向上
    expect(placementAt(244, 268, 0, 500)).toBe("top");
  });

  it("stays downward when neither side fits and below has more space", () => {
    // 下方 226 > 上方 150，两侧都不够时选下方
    expect(placementAt(150, 174, 0, 400)).toBe("bottom");
  });

  it("flips upward when neither side fits and above has more space", () => {
    // 下方 126 < 上方 250，两侧都不够时选上方
    expect(placementAt(250, 274, 0, 400)).toBe("top");
  });

  it("respects a non-zero boundary top offset", () => {
    // 裁剪容器顶部在 200，触发点上方只有 100，下方 476 足够
    expect(placementAt(300, 324, 200, 800)).toBe("bottom");
    // 下方不够且上方不够时，空间更大的一侧获胜（上方 160 > 下方 116）
    expect(placementAt(360, 384, 200, 500)).toBe("top");
  });
});
