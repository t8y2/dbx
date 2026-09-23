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
  it("blocks publishing on error severity only", () => {
    expect(source).toContain("if (nacosConfigValidationBlocksPublish(diagnostics)) {");
    expect(source).not.toContain('diagnostics.some((diagnostic) => nacosConfigDiagnosticSeverity(diagnostic) === "error")');
    // `showSuccess` now also means "the user asked for validation", so a warnings-only
    // run reports them instead of a success toast, and publishing is not blocked.
    expect(source).toContain("if (!showSuccess) return true;");
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
});
