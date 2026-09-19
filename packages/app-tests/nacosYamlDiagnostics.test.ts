import assert from "node:assert/strict";
import { test } from "vitest";
import { analyzeNacosYaml, nacosYamlDiagnosticMessageKey, translateNacosYamlDiagnostic, type NacosYamlDiagnostic } from "../../apps/desktop/src/lib/nacos/nacosYamlDiagnostics.ts";
import { nacosConfigDiagnosticSeverity, nacosConfigValidationBlocksPublish, validateNacosConfigContent } from "../../apps/desktop/src/lib/nacos/nacosConfigValidation.ts";
import en from "../../apps/desktop/src/i18n/locales/en.ts";

/** The exact text a marker underlines, so placement is asserted and not just line numbers. */
function underlined(source: string, diagnostic: NacosYamlDiagnostic): string {
  return source.slice(diagnostic.from, diagnostic.to);
}

function summarize(source: string, diagnostics: readonly NacosYamlDiagnostic[]) {
  return diagnostics.map((diagnostic) => ({ code: diagnostic.code, severity: diagnostic.severity, text: underlined(source, diagnostic), key: diagnostic.params.key }));
}

test("valid YAML produces no diagnostics", () => {
  for (const source of ["server:\n  port: 8080\n  host: localhost\n", "a: 1\n", "", "   \n", "# only a comment\n", "a:\n", "null\n", "list:\n  - 1\n  - 2\n", "base: &anchor\n  x: 1\nmerged:\n  <<: *anchor\n"]) {
    assert.deepEqual(analyzeNacosYaml(source), [], JSON.stringify(source));
  }
});

test("the same key in different mapping scopes is not a duplicate", () => {
  for (const source of ["a:\n  port: 8080\nb:\n  port: 9090\n", "a:\n  port: 1\nb:\n  c:\n    port: 2\n", "- a: 1\n- a: 2\n", "a: {x: 1}\nb: {x: 2}\n"]) {
    assert.deepEqual(analyzeNacosYaml(source), [], JSON.stringify(source));
  }
});

test("a key repeated inside one mapping is an error that underlines the repeated key", () => {
  const source = "server:\n  port: 8080\n  port: 9090\n";
  const diagnostics = analyzeNacosYaml(source);

  assert.equal(diagnostics.length, 1);
  assert.deepEqual(summarize(source, diagnostics), [{ code: "duplicateKey", severity: "error", text: "port", key: "port" }]);
  // `yaml` points at one character only, so the widened range must still start there and cover the key.
  assert.deepEqual({ from: diagnostics[0]!.from, to: diagnostics[0]!.to, line: diagnostics[0]!.line, column: diagnostics[0]!.column }, { from: source.indexOf("  port: 9090") + 2, to: source.indexOf("  port: 9090") + 6, line: 3, column: 3 });
  assert.equal(diagnostics[0]!.message, "Duplicate mapping key: port");
});

test("a key repeated at the document root is an error", () => {
  const source = "server:\n  port: 8080\nserver:\n  host: localhost\n";
  const diagnostics = analyzeNacosYaml(source);

  assert.deepEqual(summarize(source, diagnostics), [{ code: "duplicateKey", severity: "error", text: "server", key: "server" }]);
  assert.deepEqual({ line: diagnostics[0]!.line, column: diagnostics[0]!.column }, { line: 3, column: 1 });
});

test("duplicate keys are found in flow mappings, quoted keys, and sequences of mappings", () => {
  const flow = "a: {b: {c: 1, c: 2}}\n";
  assert.deepEqual(summarize(flow, analyzeNacosYaml(flow)), [{ code: "duplicateKey", severity: "error", text: "c", key: "c" }]);

  const quoted = "server:\n  \"port\": 8080\n  'port': 9090\n";
  // The duplicate (second) occurrence is the one marked, with its quotes stripped from the key name.
  assert.deepEqual(summarize(quoted, analyzeNacosYaml(quoted)), [{ code: "duplicateKey", severity: "error", text: "'port'", key: "port" }]);

  const sequence = "- a: 1\n  a: 2\n";
  assert.deepEqual(summarize(sequence, analyzeNacosYaml(sequence)), [{ code: "duplicateKey", severity: "error", text: "a", key: "a" }]);
});

test("every duplicate key is reported, not only the first", () => {
  const source = "a: 1\na: 2\nb: 3\nb: 4\n";
  assert.deepEqual(summarize(source, analyzeNacosYaml(source)), [
    { code: "duplicateKey", severity: "error", text: "a", key: "a" },
    { code: "duplicateKey", severity: "error", text: "b", key: "b" },
  ]);
});

test("tab indentation is an error that underlines the offending tab", () => {
  const source = "service:\n\tport: 8080\n";
  const diagnostics = analyzeNacosYaml(source);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.code, "tabIndent");
  assert.equal(diagnostics[0]!.severity, "error");
  assert.equal(underlined(source, diagnostics[0]!), "\t");
  assert.deepEqual({ from: diagnostics[0]!.from, to: diagnostics[0]!.to, line: diagnostics[0]!.line, column: diagnostics[0]!.column }, { from: 9, to: 10, line: 2, column: 1 });
  assert.equal(diagnostics[0]!.message, "YAML indentation must not use tab characters; use spaces instead");
});

test("tabs move anywhere except structural indentation are not reported", () => {
  // A naive leading-whitespace scan flags every one of these; only real
  // indentation tabs may be reported (#9405).
  for (const source of ["a: |\n  \tx\n", "a: |\n   x\n    \ty\n", "a: 'x\ty'\n", 'a: "x\ty"\n', "a: x\ty\n", "a:\t1\n", "a: [1,\t2]\n", "a: 1\t\n", "# c\na: 1\n\t# trailing comment line\n"]) {
    assert.deepEqual(analyzeNacosYaml(source), [], JSON.stringify(source));
  }
});

test("indentation that does not line up is a syntax error", () => {
  const source = "a:\n  b: 1\n c: 2\n";
  const diagnostics = analyzeNacosYaml(source);

  assert.equal(diagnostics[0]!.code, "syntaxError");
  assert.equal(diagnostics[0]!.severity, "error");
  assert.match(diagnostics[0]!.message, /^YAML syntax error: All mapping items must start at the same column$/);
  assert.equal(diagnostics[0]!.params.reason, "All mapping items must start at the same column");
});

test("multi-document YAML used by Spring Boot profiles stays valid", () => {
  // `parseDocument` would report MULTIPLE_DOCS here and block publishing a valid config.
  for (const source of ["a: 1\n---\nb: 2\n", "spring:\n  profiles: dev\n---\nspring:\n  profiles: prod\n", "---\na: 1\n", "%YAML 1.2\n---\na: 1\n"]) {
    assert.deepEqual(analyzeNacosYaml(source), [], JSON.stringify(source));
  }
});

test("duplicate keys are still found in a later document", () => {
  const source = "x: 1\n---\nb: 1\nb: 2\n";
  assert.deepEqual(summarize(source, analyzeNacosYaml(source)), [{ code: "duplicateKey", severity: "error", text: "b", key: "b" }]);
  assert.equal(analyzeNacosYaml(source)[0]!.line, 4);
});

test("parser warnings are downgraded so they cannot block publishing", () => {
  const source = "a: !unknownTag bar\n";
  const diagnostics = analyzeNacosYaml(source);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.code, "parserWarning");
  assert.equal(diagnostics[0]!.severity, "warning");
  assert.equal(diagnostics[0]!.params.reason, "Unresolved tag: !unknownTag");
  assert.equal(nacosConfigValidationBlocksPublish(validateNacosConfigContent(source, "yaml")), false);
});

test("one broken construct collapses into the widest marker instead of stacking", () => {
  const source = "a:\n\tb: 1\n  c: 2\n";
  // `yaml` raises TAB_AS_INDENT plus a narrower BLOCK_AS_IMPLICIT_KEY nested in a
  // MULTILINE_IMPLICIT_KEY; the nested one must not add a second marker.
  assert.deepEqual(summarize(source, analyzeNacosYaml(source)), [
    { code: "tabIndent", severity: "error", text: "\t", key: undefined },
    { code: "syntaxError", severity: "error", text: "1\n  c", key: undefined },
  ]);
});

test("every diagnostic carries a non-empty range inside the document", () => {
  const broken = ["a:\n\tb: 1\n", "a: 1\na: 2\n", "a:\n  b: 1\n c: 2\n", "a: [1, 2\n", 'a: "unterminated\n', "a: !tag x\n"];
  for (const source of broken) {
    for (const diagnostic of analyzeNacosYaml(source)) {
      assert.ok(diagnostic.from >= 0 && diagnostic.from < source.length, JSON.stringify({ source, diagnostic }));
      assert.ok(diagnostic.to > diagnostic.from && diagnostic.to <= source.length, JSON.stringify({ source, diagnostic }));
      assert.ok(diagnostic.line >= 1 && diagnostic.column >= 1, JSON.stringify({ source, diagnostic }));
      assert.ok(diagnostic.message.length > 0, JSON.stringify({ source, diagnostic }));
    }
  }
});

test("diagnostics outside YAML formats never reach the linter", () => {
  const duplicateKey = "a: 1\na: 2\n";
  for (const format of ["text", "json", "properties", "xml", "html", "toml"]) {
    assert.equal(
      validateNacosConfigContent(duplicateKey, format).some((diagnostic) => diagnostic.code === "duplicateKey"),
      false,
      format,
    );
  }
  assert.equal(
    validateNacosConfigContent(duplicateKey, "yaml").some((diagnostic) => diagnostic.code === "duplicateKey"),
    true,
  );
  assert.equal(
    validateNacosConfigContent(duplicateKey, "yml").some((diagnostic) => diagnostic.code === "duplicateKey"),
    true,
  );
});

test("only error severity blocks publishing", () => {
  assert.equal(nacosConfigValidationBlocksPublish([]), false);
  assert.equal(nacosConfigValidationBlocksPublish([{ message: "warn", line: 1, column: 1, from: 0, to: 1, severity: "warning" }]), false);
  assert.equal(nacosConfigValidationBlocksPublish([{ message: "err", line: 1, column: 1, from: 0, to: 1 }]), true);
  assert.equal(
    nacosConfigValidationBlocksPublish([
      { message: "warn", line: 1, column: 1, from: 0, to: 1, severity: "warning" },
      { message: "err", line: 1, column: 1, from: 0, to: 1 },
    ]),
    true,
  );
});

test("legacy diagnostics without a severity stay errors", () => {
  assert.equal(nacosConfigDiagnosticSeverity({ message: "x", line: 1, column: 1, from: 0, to: 1 }), "error");
  assert.equal(nacosConfigDiagnosticSeverity({ message: "x", line: 1, column: 1, from: 0, to: 1, severity: "warning" }), "warning");
});

test("diagnostic codes map to translation keys and localize with parameters", () => {
  assert.equal(nacosYamlDiagnosticMessageKey("duplicateKey"), "nacos.yamlDiagnosticDuplicateKey");
  assert.equal(nacosYamlDiagnosticMessageKey("tabIndent"), "nacos.yamlDiagnosticTabIndent");
  assert.equal(nacosYamlDiagnosticMessageKey("syntaxError"), "nacos.yamlDiagnosticSyntaxError");
  assert.equal(nacosYamlDiagnosticMessageKey("parserWarning"), "nacos.yamlDiagnosticParserWarning");

  const duplicate = analyzeNacosYaml("a: 1\na: 2\n")[0]!;
  const seen: Array<{ key: string; params: Record<string, string> }> = [];
  assert.equal(
    translateNacosYamlDiagnostic(duplicate, (key, params) => {
      seen.push({ key, params });
      return `已翻译：${params.key}`;
    }),
    "已翻译：a",
  );
  assert.deepEqual(seen, [{ key: "nacos.yamlDiagnosticDuplicateKey", params: { key: "a" } }]);
});

test("an untranslated code falls back to the English message", () => {
  const duplicate = analyzeNacosYaml("a: 1\na: 2\n")[0]!;
  // vue-i18n returns the key itself when the locale has no entry.
  assert.equal(
    translateNacosYamlDiagnostic(duplicate, (key) => key),
    "Duplicate mapping key: a",
  );
  assert.equal(
    translateNacosYamlDiagnostic(duplicate, () => ""),
    "Duplicate mapping key: a",
  );
});

test("the English fallbacks stay identical to the `en` locale entries", () => {
  const translate = (key: string, params: Record<string, string>) => {
    const template = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);
    assert.equal(typeof template, "string", key);
    return String(template).replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? "");
  };

  for (const source of ["a: 1\na: 2\n", "a:\n\tb: 1\n", "a:\n  b: 1\n c: 2\n", "a: !unknownTag bar\n"]) {
    for (const diagnostic of analyzeNacosYaml(source)) {
      assert.equal(translateNacosYamlDiagnostic(diagnostic, translate), diagnostic.message, JSON.stringify({ source, diagnostic }));
    }
  }
});
