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
  it("keeps syntax validation separate from publishing", () => {
    const saveRequest = source.slice(source.indexOf("function requestSaveConfig()"), source.indexOf("async function saveConfig()"));
    expect(saveRequest).not.toContain("validateCurrentConfig");
    expect(saveRequest).toContain("canRequestConfigSave.value");
    expect(saveRequest).toContain("void saveConfig()");
    expect(source).toContain('@click="validateCurrentConfig()"');
    expect(source).toContain("nacosConfigValidationHasErrors(configValidationDiagnostics.value)");
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
