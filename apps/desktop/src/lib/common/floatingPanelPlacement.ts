export interface FloatingPanelPlacementOptions {
  /** 触发元素的顶部坐标（与 boundary 同一坐标系） */
  triggerTop: number;
  /** 触发元素的底部坐标（与 boundary 同一坐标系） */
  triggerBottom: number;
  /** 浮动面板的整体高度 */
  panelHeight: number;
  /** 可用区域的顶部边界（例如裁剪容器的顶部或视口顶部） */
  boundaryTop: number;
  /** 可用区域的底部边界（例如裁剪容器的底部或视口底部） */
  boundaryBottom: number;
  /** 触发元素与面板之间的间距 */
  gap?: number;
}

/**
 * 根据触发点上方的可用空间决定浮动面板的弹出方向。
 * 优先向下弹出；下方放不下且上方足够时向上弹出；
 * 两侧都放不下时选择空间更大的一侧，尽量减少被裁剪的面积。
 */
export function floatingPanelPlacement(options: FloatingPanelPlacementOptions): "top" | "bottom" {
  const gap = options.gap ?? 4;
  const spaceBelow = options.boundaryBottom - options.triggerBottom;
  const spaceAbove = options.triggerTop - options.boundaryTop;
  // 下方空间刚好能放下整个面板时保持默认的向下弹出
  if (spaceBelow >= gap + options.panelHeight) return "bottom";
  // 下方不够、上方足够时翻转向上弹出
  if (spaceAbove >= gap + options.panelHeight) return "top";
  // 两侧都无法完整放下时，选择空间更大的一侧
  return spaceBelow >= spaceAbove ? "bottom" : "top";
}
