import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");

// Regression for https://github.com/t8y2/dbx/issues/7874: after using an AI
// config deep link (dbx://settings/ai/new?...) once, every later "open
// Settings" (even a plain click on the gear icon) got forcibly yanked back to
// the AI tab. Root cause: `settingsAiConfigDraft`/`settingsAiConfigRequestId`
// in App.vue are set once by `openAiConfigDeepLink` and never cleared, while
// the dialog's own "already handled this request" guard
// (`handledAiConfigRequestId`) is a plain local variable that resets to 0
// every time the dialog remounts (it's `v-if`-toggled in App.vue, so closing
// Settings destroys the instance). On the next open, `requestId !==
// handledAiConfigRequestId` is true again even though nothing new happened,
// so `applyPendingAiConfigDeepLinkDraft` reapplies the stale draft and jumps
// the user back into "ai" tab / edit mode forever, once per app run.
describe("EditorSettingsDialog AI config deep-link tab hijack", () => {
  function applyDraftBlock(): string {
    const start = dialogSource.indexOf("async function applyPendingAiConfigDeepLinkDraft()");
    const end = dialogSource.indexOf("\n}\n", start);
    if (start < 0 || end < 0) throw new Error("Missing applyPendingAiConfigDeepLinkDraft function block");
    return dialogSource.slice(start, end);
  }

  it("emits an event once the deep-link draft has been consumed", () => {
    expect(dialogSource).toContain('"ai-config-deep-link-handled": []');
    expect(applyDraftBlock()).toContain('emit("ai-config-deep-link-handled")');
  });

  it("App.vue clears the draft/request state once notified, so a remounted dialog can't reapply it", () => {
    expect(appSource).toContain('@ai-config-deep-link-handled="settingsAiConfigDraft = null"');
  });
});
