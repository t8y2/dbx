/**
 * Error categories the provider reports through `[category]` prefixes, mapped
 * to the i18n key that explains what to check (#15393: the raw error text
 * alone did not tell the user whether the key, the endpoint, the model or the
 * gateway was at fault).
 */
export const AI_TEST_ERROR_CATEGORY_KEYS: Record<string, string> = {
  auth: "ai.testErrorAuth",
  modelNotFound: "ai.testErrorModelNotFound",
  rateLimit: "ai.testErrorRateLimit",
  timeout: "ai.testErrorTimeout",
  tokenLimit: "ai.testErrorTokenLimit",
  safety: "ai.testErrorSafety",
  emptyResponse: "ai.testErrorEmptyResponse",
  modelDiscoveryUnsupported: "ai.modelListUnsupported",
  network: "ai.testErrorNetwork",
  serverError: "ai.testErrorServer",
  unknown: "ai.testErrorUnknown",
};

export interface AiTestErrorPresentation {
  /** Localized one-liner telling the user what to check. */
  summary: string;
  /** The provider's raw detail, shown as-is under the summary. */
  detail: string;
}

/**
 * Splits a `[category] detail` error into a localized summary plus the raw
 * detail. A message without a known category keeps its text as the detail so
 * nothing is hidden from the user.
 */
export function aiTestErrorPresentationOf(error: string, translate: (key: string) => string): AiTestErrorPresentation {
  const match = /^\[([^\]]+)]\s*(.*)$/s.exec(error);
  if (!match) return { summary: "", detail: error };
  const key = AI_TEST_ERROR_CATEGORY_KEYS[match[1]!];
  return key ? { summary: translate(key), detail: match[2]! } : { summary: "", detail: error };
}
