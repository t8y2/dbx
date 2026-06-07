export const IMAGE_PREVIEW_MIN_SCALE = 0.2;
export const IMAGE_PREVIEW_MAX_SCALE = 8;
export const IMAGE_PREVIEW_ZOOM_STEP = 0.2;

export type ImagePreviewZoomDirection = "in" | "out";

export function clampImagePreviewScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(Math.max(Number(scale.toFixed(2)), IMAGE_PREVIEW_MIN_SCALE), IMAGE_PREVIEW_MAX_SCALE);
}

export function nextImagePreviewScale(scale: number, direction: ImagePreviewZoomDirection): number {
  const delta = direction === "in" ? IMAGE_PREVIEW_ZOOM_STEP : -IMAGE_PREVIEW_ZOOM_STEP;
  return clampImagePreviewScale(scale + delta);
}

export function imagePreviewFitScale(options: {
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  paddingRatio?: number;
}): number {
  if (
    options.imageWidth <= 0 ||
    options.imageHeight <= 0 ||
    options.viewportWidth <= 0 ||
    options.viewportHeight <= 0
  ) {
    return 1;
  }
  const paddingRatio = options.paddingRatio ?? 0.9;
  const widthScale = (options.viewportWidth * paddingRatio) / options.imageWidth;
  const heightScale = (options.viewportHeight * paddingRatio) / options.imageHeight;
  return clampImagePreviewScale(Math.min(widthScale, heightScale, 1));
}

export function imagePreviewTransform(options: { scale: number; offsetX: number; offsetY: number }): string {
  return `translate(${options.offsetX}px, ${options.offsetY}px) scale(${options.scale})`;
}
