import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");
const localePaths = ["en", "es", "it", "ja", "ko", "pt-BR", "zh-CN", "zh-TW"];

describe("AI assistant write confirmation replacement", () => {
  it("renders a localized confirmation from the backend's semantic event", () => {
    expect(source).toContain("function replaceAssistantText(assistantIdx: number, content: string)");
    expect(source).toContain('pendingAssistantDelta = "";');
    expect(source).toContain("msg.content = content;");
    expect(source).toContain("function writeSqlConfirmationText(sql: string)");
    expect(source).toContain('event.type === "write_sql_confirmation_required"');
    expect(source).toContain("replaceAssistantText(assistantIdx, writeSqlConfirmationText(event.sql));");
    expect(source).toContain('event.type === "production_write_blocked"');
  });

  it("does not render an executable write confirmation without exact SQL", () => {
    expect(source).toContain("looksLikeWriteSqlProposal(msg.content) && !isActionableWriteSqlProposal(msg.content)");
    expect(source).toContain('if (positive && assistantMode.value === "agent" && isWriteConfirmation)');
  });

  it("routes generic action replies separately from write-SQL replies", () => {
    expect(source).toContain('isWriteConfirmation ? t("ai.writeSqlConfirmationReplyYes") : t("ai.proposalConfirmReplyYes")');
    expect(source).toContain('isWriteConfirmation ? t("ai.writeSqlConfirmationReplyNo") : t("ai.proposalConfirmReplyNo")');
  });

  it("marks backend-generated confirmations as structurally actionable", () => {
    expect(source).toContain('msg.kind = "writeSqlConfirmation";');
    expect(source).toContain('msg.kind = "productionWriteBlocked";');
    expect(source).toContain('if (msg.kind === "writeSqlConfirmation") return extractSingleSqlCodeBlock(msg.content) ? msg : null;');
    expect(source).toContain("isActionableWriteProposalMessage(msg)");
  });

  it("provides the write-confirmation wording in every supported locale", () => {
    for (const locale of localePaths) {
      const messages = readFileSync(new URL(`../../../i18n/locales/${locale}.ts`, import.meta.url), "utf8");
      expect(messages).toContain("writeSqlConfirmationRequired:");
      expect(messages).toContain("writeSqlConfirmationQuestion:");
      expect(messages).toContain("writeSqlConfirmYes:");
      expect(messages).toContain("writeSqlConfirmNo:");
      expect(messages).toContain("productionWriteBlocked:");
      expect(messages).toContain("proposalConfirmReplyYes:");
      expect(messages).toContain("proposalConfirmReplyNo:");
    }
  });
});
