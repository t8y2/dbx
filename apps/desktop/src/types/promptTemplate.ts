export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export const PROMPT_TEMPLATE_NAME_MAX = 50;
export const PROMPT_TEMPLATE_CONTENT_MAX = 8000;
export const GLOBAL_INSTRUCTIONS_MAX = 8000;
export const ACTIVE_TEMPLATES_TOTAL_MAX = 16000;

/** Matches Rust str::chars().count() for frontend prompt validation. */
export function promptTemplateCharacterCount(value: string): number {
  return Array.from(value).length;
}
