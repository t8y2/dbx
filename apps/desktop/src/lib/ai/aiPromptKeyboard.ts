export interface AiPromptKeydownLikeEvent {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export function isAiPromptImeCompositionEvent(event: AiPromptKeydownLikeEvent, compositionActive = false): boolean {
  return compositionActive || !!event.isComposing || event.keyCode === 229 || event.key === "Process";
}

export function shouldSubmitAiPromptOnKeydown(event: AiPromptKeydownLikeEvent, compositionActive = false): boolean {
  if (event.key !== "Enter") return false;
  if (event.shiftKey) return false;
  if (isAiPromptImeCompositionEvent(event, compositionActive)) return false;
  return true;
}
