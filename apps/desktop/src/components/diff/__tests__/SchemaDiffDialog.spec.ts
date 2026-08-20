import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../SchemaDiffDialog.vue", import.meta.url), "utf8");

describe("SchemaDiffDialog fullscreen layout", () => {
  it("fits the dialog to its portal instead of the viewport width", () => {
    expect(dialogSource).toContain('width: "100%"');
    expect(dialogSource).toContain('height: "100%"');
    expect(dialogSource).not.toContain('width: "100vw"');
    expect(dialogSource).not.toContain('height: "100vh"');
  });

  it("removes the normal dialog gutter and minimum width while maximized", () => {
    expect(dialogSource).toContain(":portal-class=\"isMaximized ? 'p-0' : undefined\"");
    expect(dialogSource).toContain("isMaximized ? 'min-w-0' : 'min-w-[800px] resize'");
  });

  it("closes the options panel before allowing Escape to dismiss the dialog", () => {
    expect(dialogSource).toContain('@escape-key-down="handleDialogEscape"');
    expect(dialogSource).toContain("if (!showOptionsPanel.value) return;");
    expect(dialogSource).toContain("event.preventDefault();");
    expect(dialogSource).toContain("showOptionsPanel.value = false;");
  });

  it("lets the deploy confirm dialog body shrink so a long destructive statement can't push the footer buttons off-screen", () => {
    expect(dialogSource).toContain('<div class="py-2 space-y-3 min-w-0">');
  });

  it("lets the config step scroll vertically so the Compare button stays reachable when 'compare specific tables' is enabled", () => {
    // Regression for #6627: the "compare specific tables" feature (#6533/#6540) grows the
    // config step (table multi-select + same-name match). Under a fixed-height dialog that
    // step used to be clipped (`overflow-hidden`), pushing the Compare button below the
    // visible area with no way to scroll to it. The container must scroll on all steps
    // except the result step, which relies on splitpanes to manage its own height.
    expect(dialogSource).toContain("step === 'result' ? 'overflow-hidden' : 'overflow-y-auto'");
    // The config step must not be flex-shrunk (which would swallow its height and suppress
    // the scrollbar); only then does the taller-than-dialog content actually overflow and
    // become reachable via scrolling.
    expect(dialogSource).toMatch(/<SchemaDiffConfigStep\n[\s\S]*?class="shrink-0"/);
  });
});
