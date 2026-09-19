import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en";

const source = readFileSync(new URL("../NacosAdminConsole.vue", import.meta.url), "utf8");

/**
 * The lint itself is covered by real CodeMirror integration specs
 * (`lib/__tests__/nacos/nacosConfigYamlLint.spec.ts` and
 * `packages/app-tests/nacosYamlDiagnostics.test.ts`). These assertions pin the
 * wiring that only exists inside this component, which is too large to mount.
 */
describe("NacosAdminConsole YAML diagnostics wiring", () => {
  it("installs and seeds the linter only for YAML configs", () => {
    expect(source).toContain('...(format === "yaml" ? [nacosConfigYamlLintExtension(configDiagnosticTranslate)] : []),');
    expect(source).toContain('if (format === "yaml") view.dispatch(setDiagnostics(view.state, nacosConfigYamlLintDiagnostics(view.state.doc.toString(), configDiagnosticTranslate)));');
    // A YAML-only extension: each helper has exactly one call site, inside the gated branch.
    expect(source.match(/nacosConfigYamlLintExtension\(/g)).toHaveLength(1);
    expect(source.match(/nacosConfigYamlLintDiagnostics\(/g)).toHaveLength(1);
  });

  it("keeps the lint logic out of the component", () => {
    // The component only formats and displays diagnostics; it never parses YAML itself.
    expect(source).not.toContain("analyzeNacosYaml(");
    expect(source).not.toContain("parseAllDocuments(");
    expect(source).not.toContain("parseDocument(");
    expect(source).toContain('import { setDiagnostics } from "@codemirror/lint";');
    expect(source).toContain('import { nacosConfigYamlLintDiagnostics, nacosConfigYamlLintExtension } from "@/lib/nacos/nacosConfigYamlLint";');
    expect(source).toContain('import { translateNacosYamlDiagnostic } from "@/lib/nacos/nacosYamlDiagnostics";');
  });

  it("blocks publishing on error severity only", () => {
    expect(source).toContain("if (nacosConfigValidationBlocksPublish(diagnostics)) {");
    expect(source).not.toContain('diagnostics.some((diagnostic) => nacosConfigDiagnosticSeverity(diagnostic) === "error")');
    // `showSuccess` now also means "the user asked for validation", so a warnings-only
    // run reports them instead of a success toast, and publishing is not blocked.
    expect(source).toContain("if (!showSuccess) return true;");
  });

  it("does not double-mark YAML diagnostics with the legacy decoration", () => {
    expect(source).toContain('const configUsesYamlLint = computed(() => resolveNacosConfigFormat(configType.value, configDataId.value) === "yaml");');
    expect(source).toContain("configValidationHighlightActive = !configUsesYamlLint.value;");
    expect(source).toContain("effects: setConfigValidationHighlight.of(configUsesYamlLint.value ? [] : configValidationDiagnostics.value),");
  });

  it("reports severity and localized messages in the validation dialog", () => {
    expect(source).toContain('{{ configValidationHasError ? t("nacos.validationErrorTitle") : t("nacos.validationWarningTitle") }}');
    expect(source).toContain('{{ configValidationHasError ? t("nacos.validationErrorDescription") : t("nacos.validationWarningDescription") }}');
    // Asserted separately because the formatter may wrap the spans.
    expect(source).toContain("{{ configValidationSeverityLabel(diagnostic) }}");
    expect(source).toContain("{{ configValidationMessage(diagnostic) }}");
    // The localized text is resolved through the shared helper, never a raw parser string.
    expect(source).toContain("return diagnostic.code ? translateNacosYamlDiagnostic({ code: diagnostic.code, message: diagnostic.message, params: diagnostic.params ?? {} }, configDiagnosticTranslate) : diagnostic.message;");
  });

  it("localizes every key it references, including the new severity labels", () => {
    const referenced = [
      "validationErrorTitle",
      "validationErrorDescription",
      "validationWarningTitle",
      "validationWarningDescription",
      "validationSeverityError",
      "validationSeverityWarning",
      "yamlDiagnosticDuplicateKey",
      "yamlDiagnosticTabIndent",
      "yamlDiagnosticSyntaxError",
      "yamlDiagnosticParserWarning",
    ];
    const nacos = en.nacos as Record<string, unknown>;
    for (const key of referenced) {
      expect(typeof nacos[key], key).toBe("string");
      expect((nacos[key] as string).length, key).toBeGreaterThan(0);
    }
  });

  it("adds no watcher, listener, or observer for live diagnostics", () => {
    // CodeMirror owns the debounce; a component-level watcher would re-parse on
    // every keystroke and leak across config switches.
    expect(source.match(/watch\(/g)).toHaveLength(6);
    expect(source.match(/addEventListener\(/g)).toHaveLength(1);
    expect(source.match(/removeEventListener\(/g)).toHaveLength(1);
    expect(source.match(/onMounted\(/g)).toHaveLength(1);
    expect(source.match(/new ResizeObserver/g)).toHaveLength(1);
  });

  it("still tears the editor view down when the config changes", () => {
    expect(source).toContain("configEditorView.value?.destroy();");
    expect(source).toContain("configEditorView.value = null;");
    expect(source).toContain("await refreshConfigEditor();");
  });
});
