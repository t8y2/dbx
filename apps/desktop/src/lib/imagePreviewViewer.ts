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

export function imagePreviewFitScale(options: { imageWidth: number; imageHeight: number; viewportWidth: number; viewportHeight: number; paddingRatio?: number }): number {
  if (options.imageWidth <= 0 || options.imageHeight <= 0 || options.viewportWidth <= 0 || options.viewportHeight <= 0) {
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

export function imagePreviewDialogSize(options: {
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  toolbarHeight?: number;
  maxWidthRatio?: number;
  maxHeightRatio?: number;
  maxWidth?: number;
  maxHeight?: number;
  minWidth?: number;
  minStageHeight?: number;
}): { width: number; height: number } | null {
  if (options.imageWidth <= 0 || options.imageHeight <= 0 || options.viewportWidth <= 0 || options.viewportHeight <= 0) {
    return null;
  }

  const toolbarHeight = options.toolbarHeight ?? 48;
  const maxWidth = Math.min(options.viewportWidth * (options.maxWidthRatio ?? 0.92), options.maxWidth ?? 1280);
  const maxHeight = Math.min(options.viewportHeight * (options.maxHeightRatio ?? 0.86), options.maxHeight ?? 920);
  const maxStageHeight = Math.max(1, maxHeight - toolbarHeight);
  const minWidth = Math.min(maxWidth, options.minWidth ?? 360);
  const minStageHeight = Math.min(maxStageHeight, options.minStageHeight ?? 180);
  const imageRatio = options.imageWidth / options.imageHeight;
  let stageWidth = maxWidth;
  let stageHeight = stageWidth / imageRatio;

  if (stageHeight > maxStageHeight) {
    stageHeight = maxStageHeight;
    stageWidth = stageHeight * imageRatio;
  }

  stageWidth = Math.min(maxWidth, Math.max(stageWidth, minWidth));
  stageHeight = Math.min(maxStageHeight, Math.max(stageHeight, minStageHeight));

  return {
    width: Math.max(1, Math.floor(stageWidth)),
    height: Math.max(1, Math.floor(stageHeight + toolbarHeight)),
  };
}
