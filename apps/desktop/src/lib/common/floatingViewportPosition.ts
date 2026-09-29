export interface FloatingRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface FloatingViewport {
  width: number;
  height: number;
}

/** Place a cursor-following surface, flipping each axis before clamping to the viewport. */
export function floatingCursorPosition(cursor: { x: number; y: number }, size: { width: number; height: number }, viewport: FloatingViewport, preferredSide: "left" | "right" = "right", gap = 12, margin = 8): { x: number; y: number } {
  function axis(pointer: number, length: number, extent: number, before: boolean) {
    const inset = Math.min(margin, Math.max(0, extent / 2));
    const maximum = Math.max(inset, extent - inset - length);
    const preferred = before ? pointer - gap - length : pointer + gap;
    const alternative = before ? pointer + gap : pointer - gap - length;
    const fits = (value: number) => value >= inset && value + length <= extent - inset;
    const position = fits(preferred) ? preferred : fits(alternative) ? alternative : preferred;
    return Math.min(maximum, Math.max(inset, position));
  }
  return {
    x: axis(cursor.x, size.width, viewport.width, preferredSide === "left"),
    y: axis(cursor.y, size.height, viewport.height, false),
  };
}

export function floatingViewportShift(rect: FloatingRect, viewport: FloatingViewport, margin = 8): { x: number; y: number } {
  let x = 0;
  let y = 0;

  if (rect.left < margin) x = margin - rect.left;
  else if (rect.right > viewport.width - margin) x = viewport.width - margin - rect.right;

  if (rect.top < margin) y = margin - rect.top;
  else if (rect.bottom > viewport.height - margin) y = viewport.height - margin - rect.bottom;

  return { x, y };
}

export function floatingArrowOffset(length: number, shift: number, padding = 8): number {
  const maximum = Math.max(padding, length - padding);
  return Math.min(Math.max(padding, length / 2 - shift), maximum);
}
