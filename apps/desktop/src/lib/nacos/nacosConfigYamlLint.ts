/**
 * CodeMirror lint wiring for Nacos YAML configs (#9405).
 *
 * Kept apart from `nacosYamlDiagnostics.ts` so the analysis stays a pure,
 * dependency-free function that any host can unit test, while this module only
 * adapts it to `@codemirror/lint`'s `Diagnostic` shape.
 *
 * The `delay` option is the debounce: CodeMirror parses once the editor has been
 * idle for `NACOS_YAML_LINT_DELAY_MS` after the last change instead of on every
 * keystroke, and only a fresh `EditorState` (a newly opened config) resets it.
 */
import { linter, type Diagnostic, type LintSource } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { analyzeNacosYaml, translateNacosYamlDiagnostic, type NacosYamlDiagnosticTranslator } from "@/lib/nacos/nacosYamlDiagnostics";

export const NACOS_YAML_LINT_DELAY_MS = 500;

/**
 * The `Diagnostic`s for `content`, translated for the active locale.
 *
 * Exposed separately because `linter()` only schedules a run after a document
 * change, so a config opened with a pre-existing error would look clean until
 * the first keystroke. Hosts seed the initial markers with `setDiagnostics`
 * using this same function, keeping one source of truth for the analysis.
 */
export function nacosConfigYamlLintDiagnostics(content: string, translate: NacosYamlDiagnosticTranslator): Diagnostic[] {
  return analyzeNacosYaml(content).map((diagnostic) => ({
    from: diagnostic.from,
    to: diagnostic.to,
    severity: diagnostic.severity,
    message: translateNacosYamlDiagnostic(diagnostic, translate),
  }));
}

/** Native YAML diagnostics: wavy underline per problem plus the hover tooltip. */
export function nacosConfigYamlLintExtension(translate: NacosYamlDiagnosticTranslator): Extension {
  const source: LintSource = (view): readonly Diagnostic[] => nacosConfigYamlLintDiagnostics(view.state.doc.toString(), translate);
  return linter(source, { delay: NACOS_YAML_LINT_DELAY_MS });
}
