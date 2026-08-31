import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const settingsDialogSource = readFileSync(new URL("../../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");
const changelogPanelSource = readFileSync(new URL("../../../components/settings/ChangelogPanel.vue", import.meta.url), "utf8");

describe("about page update check", () => {
  it("reuses the toolbar update check and pending state", () => {
    expect(changelogPanelSource).toContain('"check-updates": []');
    expect(changelogPanelSource).toContain("@click=\"emit('check-updates')\"");
    expect(changelogPanelSource).toContain(':disabled="checkingUpdates"');
    expect(settingsDialogSource).toContain(':checking-updates="props.checkingUpdates"');
    expect(settingsDialogSource).toContain("@check-updates=\"emit('check-updates')\"");
    expect(appSource).toContain(':checking-updates="checkingUpdates"');
    expect(appSource).toContain('@check-updates="checkUpdates()"');
  });
});
