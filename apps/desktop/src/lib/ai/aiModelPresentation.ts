export interface AiModelPresentation {
  primary: string;
  secondary?: string;
}

function compactModelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

export function shouldShowAiModelSecondaryLabel(label: string, modelId: string): boolean {
  const normalizedLabel = compactModelName(label);
  const normalizedId = compactModelName(modelId);
  if (!normalizedLabel || !normalizedId || normalizedLabel === normalizedId) return false;
  return true;
}

export function formatAiModelOption(label: string, modelId: string): AiModelPresentation {
  return {
    primary: label || modelId,
    secondary: shouldShowAiModelSecondaryLabel(label, modelId) ? modelId : undefined,
  };
}
