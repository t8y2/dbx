// Guards the settings-search "reveal" contract for the debug logging switch
// (#10308): searching 日志 and picking the result must land on the tab that
// actually renders the switch, because the dialog switches tabs from the search
// entry's category. The entry used to declare "appearance" while the control
// lives in the About section, so the highlight never appeared. Checked against
// the real dialog source instead of mounting the multi-thousand-line dialog.
import { describe, expect, it } from "vitest";
import { SETTINGS_SEARCH_DEFINITIONS } from "@/lib/settings/settingsSearch";
import dialogSource from "../EditorSettingsDialog.vue?raw";

const DEBUG_LOGGING_SWITCH_ID = 'id="debug-logging-enabled"';

function tabRenderingSnippet(snippet: string, marker: string): string | null {
  const sectionPattern = /activeSettingsTab === '([a-z-]+)'/g;
  const sections: { tab: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = sectionPattern.exec(snippet))) sections.push({ tab: match[1], index: match.index });
  const markerIndex = snippet.indexOf(marker);
  if (markerIndex < 0) return null;
  let owningTab: string | null = null;
  for (const section of sections) {
    if (section.index < markerIndex) owningTab = section.tab;
  }
  return owningTab;
}

describe("EditorSettingsDialog settings search targets", () => {
  it("renders the debug logging switch in the tab its search entry points at", () => {
    const owningTab = tabRenderingSnippet(dialogSource, DEBUG_LOGGING_SWITCH_ID);
    expect(owningTab).toBe("about");

    const entry = SETTINGS_SEARCH_DEFINITIONS.find((definition) => definition.id === "about-debug-logs");
    expect(entry?.category).toBe(owningTab);
    expect(dialogSource).toContain(`data-settings-search-id="${entry?.targetId}"`);
  });
});
