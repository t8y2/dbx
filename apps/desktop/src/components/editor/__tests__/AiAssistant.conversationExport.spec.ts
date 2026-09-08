import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");

describe("AI assistant conversation export", () => {
  it("passes native save-dialog short extensions, never the bare format key", () => {
    expect(source).toContain('saveTextFile(result.content, result.defaultFileName, format === "markdown" ? "Markdown" : "HTML", format === "markdown" ? "md" : "html")');
    expect(source).not.toMatch(/saveTextFile\([^)]*,\s*format\)/);
  });

  it("records the failure on the message state at the same point the prefix text is written", () => {
    expect(source).toContain("msg.failed = true;");
  });

  it("persists the failed flag through both conversation snapshot paths", () => {
    // buildConversationSnapshot and persistPendingInputRecovery both whitelist
    // fields on the way to storage; serde drops unknown fields on the Rust
    // side, so a path that forgets `failed` silently loses the marker.
    expect(source).toContain("...(m.failed ? { failed: true } : {})");
    expect(source).toContain("failed: m.failed === true ? true : undefined");
  });

  it("derives the export failure marker from persisted state and run status, not locale text", () => {
    expect(source).toContain("failed: msg.failed === true || (runFailed && msg === failedTurnAssistant)");
    expect(source).not.toContain('msg.content.startsWith(t("ai.requestFailed"))');
  });

  it("attributes run-status failure only to an assistant reply after the latest user turn", () => {
    // Restart-before-first-delta regression: when a run is restored as
    // interrupted before producing any output, the last reply in the transcript
    // belongs to the PRECEDING successful turn — it must stay unmarked.
    expect(source).toContain("let lastUserIndex = -1;");
    expect(source).toContain("i > lastUserIndex");
    expect(source).toContain("failedTurnAssistant = candidate;");
    expect(source).not.toContain("lastVisibleAssistant");
  });

  it("consults the run registry / fallback status map for background-failed turns", () => {
    expect(source).toContain("function isCurrentRunFailed()");
    expect(source).toContain('return status === "failed" || status === "interrupted";');
  });
});
