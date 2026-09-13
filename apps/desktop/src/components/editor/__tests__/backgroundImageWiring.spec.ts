import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const composableSource = readFileSync(new URL("../../../composables/useBackgroundImage.ts", import.meta.url), "utf8");
const globalsCss = readFileSync(new URL("../../../../src/styles/globals.css", import.meta.url), "utf8");
const queryEditorSource = readFileSync(new URL("../QueryEditor.vue", import.meta.url), "utf8");
const welcomeScreenSource = readFileSync(new URL("../../layout/WelcomeScreen.vue", import.meta.url), "utf8");

describe("global background image wiring", () => {
  it("mounts a single app-level background layer behind all content", () => {
    expect(appSource).toContain("data-app-background");
    expect(appSource).toMatch(/pointer-events-none fixed inset-0 -z-10/);
    expect(appSource).toContain("useBackgroundImage(settingsStore)");
  });

  it("toggles the wallpaper class on <html> and clears CodeMirror backgrounds app-wide", () => {
    expect(composableSource).toContain('BACKGROUND_IMAGE_ACTIVE_CLASS = "dbx-bg-active"');
    expect(globalsCss).toContain("html.dbx-bg-active .cm-editor");
    expect(globalsCss).toContain("html.dbx-bg-active .cm-gutters");
  });

  it("keeps card and popover surfaces opaque (readability contract)", () => {
    expect(composableSource).toContain("BACKGROUND_IMAGE_SURFACE_VARS");
    const appBackground = readFileSync(new URL("../../../lib/app/appBackgroundImage.ts", import.meta.url), "utf8");
    expect(appBackground).toContain('"--background"');
    expect(appBackground).toContain('"--sidebar"');
    expect(appBackground).not.toMatch(/"--card"|"--popover"/);
  });

  it("removed the scoped per-area mode (editor/welcome no longer render their own layers)", () => {
    for (const source of [queryEditorSource, welcomeScreenSource]) {
      expect(source).not.toContain("useBackgroundImage");
      expect(source).not.toContain("data-query-editor-bg");
      expect(source).not.toContain("data-welcome-bg");
    }
  });
});
