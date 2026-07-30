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
