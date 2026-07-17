import { describe, expect, it } from "vitest";
import { formatMqTokenIssueError } from "@/lib/mq/mqTokenErrors";

describe("MQ token errors", () => {
  it("turns missing signing configuration backend errors into locale keys", () => {
    const result = formatMqTokenIssueError("/api/mq/tokens/issue returned 500: Token signing is not configured for this MQ connection");

    expect(result.kind).toBe("missingSigningKey");
    if (result.kind === "missingSigningKey") {
      expect(result.titleKey).toBe("mqPermissions.missingSigningKeyTitle");
      expect(result.messageKey).toBe("mqPermissions.missingSigningKeyMessage");
      expect(result.detailKey).toBe("mqPermissions.missingSigningKeyDetail");
    }
  });

  it("keeps unrelated errors as ordinary messages", () => {
    const result = formatMqTokenIssueError("network failed");

    expect(result.kind).toBe("generic");
    if (result.kind === "generic") {
      expect(result.message).toBe("network failed");
    }
  });
});
