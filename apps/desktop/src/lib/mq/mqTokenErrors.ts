export type MqTokenIssueErrorView =
  | {
      kind: "missingSigningKey";
      title: string;
      message: string;
      detail: string;
    }
  | {
      kind: "generic";
      title?: undefined;
      message: string;
      detail?: undefined;
    };

export function formatMqTokenIssueError(error: unknown): MqTokenIssueErrorView {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (isMissingTokenSigningConfig(message)) {
    return {
      kind: "missingSigningKey",
      title: "未配置 Token 签发密钥",
      message: "当前 MQ 连接还没有配置 Broker Token 签发密钥，无法生成客户端 Token。",
      detail: "请编辑该连接，在 MQ 配置中设置“Broker Token 签发”为 HS256 SECRET 或 RS256 PRIVATE，并填写签发密钥后再生成。",
    };
  }
  return { kind: "generic", message };
}

function isMissingTokenSigningConfig(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("token signing is not configured") || normalized.includes("token signing key is required") || normalized.includes("broker token signing key is required");
}
