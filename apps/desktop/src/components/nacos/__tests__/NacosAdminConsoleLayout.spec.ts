import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../NacosAdminConsole.vue", import.meta.url), "utf8");

describe("NacosAdminConsole config workbench layout", () => {
  it("keeps the editor as the final and primary workbench surface", () => {
    const contextBar = source.indexOf('class="nacos-config-context-bar');
    const inspector = source.indexOf('class="nacos-config-inspector');
    const toolbar = source.indexOf('class="nacos-editor-toolbar');
    const editor = source.indexOf('ref="configEditorHost"');

    expect(contextBar).toBeGreaterThan(0);
    expect(inspector).toBeGreaterThan(contextBar);
    expect(toolbar).toBeGreaterThan(inspector);
    expect(editor).toBeGreaterThan(toolbar);
  });

  it("uses split-pane container queries instead of viewport breakpoints", () => {
    expect(source).toContain(".nacos-config-workbench {\n  container-type: inline-size;");
    expect(source).toContain("@container (min-width: 960px)");
    expect(source).toContain("@container (max-width: 480px)");
    expect(source.indexOf('class="nacos-editor-actions-secondary')).toBeLessThan(source.indexOf('class="nacos-editor-actions-primary'));
    expect(source).toContain("grid-template-columns: minmax(0, 1fr) auto;");
  });

  it("tracks format and metadata changes as unsaved configuration state", () => {
    expect(source).toContain("configType.value !== originalConfigType.value");
    expect(source).toContain('(selectedConfig.value.appName || "") !== originalConfigMetadata.value.appName');
    expect(source).toContain('(selectedConfig.value.desc || "") !== originalConfigMetadata.value.desc');
    expect(source).toContain('(selectedConfig.value.tags || "") !== originalConfigMetadata.value.tags');
  });

  it("returns a stale batch apply to preview instead of retrying an expired plan", () => {
    const staleBranch = source.indexOf('isNacosErrorCode(error, "stalePreview")');

    expect(staleBranch).toBeGreaterThan(0);
    expect(source.indexOf("batchPreview.value = null;", staleBranch)).toBeGreaterThan(staleBranch);
    expect(source.indexOf("batchTransferRequest.value = null;", staleBranch)).toBeGreaterThan(staleBranch);
    expect(source.indexOf('batchError.value = t("nacos.previewExpired");', staleBranch)).toBeGreaterThan(staleBranch);
  });
});
