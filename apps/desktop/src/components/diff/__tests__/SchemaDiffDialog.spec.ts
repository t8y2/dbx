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
});
