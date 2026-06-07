export function scrollbarGutterWidth(element: Pick<HTMLElement, "offsetWidth" | "clientWidth">): number {
  return Math.max(0, element.offsetWidth - element.clientWidth);
}

export function dataGridHeaderContentWidth(baseWidth: string, gutterWidth: number): string {
  return gutterWidth > 0 ? `calc(${baseWidth} + ${gutterWidth}px)` : baseWidth;
}
