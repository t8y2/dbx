export interface ConditionInputExpansionMetrics {
  value: string;
  textWidth: number;
  contentHeight: number;
  inputWidth: number;
  inputHeight: number;
}

export function shouldExpandConditionInput(metrics: ConditionInputExpansionMetrics): boolean {
  if (!metrics.value) return false;
  return /\r?\n/.test(metrics.value) || metrics.textWidth > metrics.inputWidth + 1 || metrics.contentHeight > metrics.inputHeight + 1;
}
