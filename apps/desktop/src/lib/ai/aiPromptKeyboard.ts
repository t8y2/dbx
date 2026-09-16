export interface AiPromptKeydownLikeEvent {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export interface AiPromptSubmissionState {
  prompt: string;
  contextItemCount: number;
  isAttachmentProcessing: boolean;
  hasTab: boolean;
  hasConnection: boolean;
}

export function canSubmitAiPrompt(state: AiPromptSubmissionState): boolean {
  return !state.isAttachmentProcessing && state.hasTab && state.hasConnection && (state.prompt.trim().length > 0 || state.contextItemCount > 0);
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
