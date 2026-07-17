export type MqTokenIssueErrorView =
  | {
      kind: "missingSigningKey";
      titleKey: "mqPermissions.missingSigningKeyTitle";
      messageKey: "mqPermissions.missingSigningKeyMessage";
      detailKey: "mqPermissions.missingSigningKeyDetail";
    }
  | {
      kind: "generic";
      titleKey?: undefined;
      messageKey?: undefined;
      detailKey?: undefined;
      message: string;
    };

export function formatMqTokenIssueError(error: unknown): MqTokenIssueErrorView {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (isMissingTokenSigningConfig(message)) {
    return {
      kind: "missingSigningKey",
      titleKey: "mqPermissions.missingSigningKeyTitle",
      messageKey: "mqPermissions.missingSigningKeyMessage",
      detailKey: "mqPermissions.missingSigningKeyDetail",
    };
  }
  return { kind: "generic", message };
}

function isMissingTokenSigningConfig(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("token signing is not configured") || normalized.includes("token signing key is required") || normalized.includes("broker token signing key is required");
}
