import { describe, expect, it } from "vitest";
import { formatMqTokenIssueError } from "../mqTokenErrors";

describe("MQ token errors", () => {
  it("turns missing signing configuration backend errors into actionable Chinese copy", () => {
    const result = formatMqTokenIssueError("/api/mq/tokens/issue returned 500: Token signing is not configured for this MQ connection");

    expect(result.kind).toBe("missingSigningKey");
    expect(result.title).toBe("未配置 Token 签发密钥");
    expect(result.message).toContain("无法生成客户端 Token");
    expect(result.detail).toContain("Broker Token 签发");
  });

  it("keeps unrelated errors as ordinary messages", () => {
    const result = formatMqTokenIssueError("network failed");

    expect(result.kind).toBe("generic");
    expect(result.title).toBeUndefined();
    expect(result.message).toBe("network failed");
  });
});
