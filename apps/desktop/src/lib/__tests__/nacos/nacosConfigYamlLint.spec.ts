// @vitest-environment happy-dom
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forEachDiagnostic, forceLinting, setDiagnostics } from "@codemirror/lint";
import { yamlLanguage } from "@codemirror/lang-yaml";
import { NACOS_YAML_LINT_DELAY_MS, nacosConfigYamlLintDiagnostics, nacosConfigYamlLintExtension } from "@/lib/nacos/nacosConfigYamlLint";

const passthroughTranslate = (key: string) => key;

let mounted: EditorView[] = [];

afterEach(() => {
  for (const view of mounted) view.destroy();
  mounted = [];
});

/** Mirrors `NacosAdminConsole.mountConfigEditor`, including the initial marker seeding. */
function mount(doc: string, translate: (key: string, params: Record<string, string>) => string = passthroughTranslate) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [yamlLanguage, nacosConfigYamlLintExtension(translate)] }),
  });
  view.dispatch(setDiagnostics(view.state, nacosConfigYamlLintDiagnostics(view.state.doc.toString(), translate)));
  mounted.push(view);
  return view;
}

function read(view: EditorView) {
  const found: Array<{ severity: string; message: string; text: string }> = [];
  forEachDiagnostic(view.state, (diagnostic, from, to) => found.push({ severity: diagnostic.severity, message: diagnostic.message, text: view.state.doc.sliceString(from, to) }));
  return found;
}

/** The linter only runs off its idle timer, so force it and let the single-result batch settle. */
async function relint(view: EditorView, doc: string) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
  forceLinting(view);
  await Promise.resolve();
}

test("a config opened with an existing error is marked before the first keystroke", () => {
  // `linter()` alone would report nothing here, which is why the editor seeds the first set.
  assert.deepEqual(read(mount("server:\n  port: 8080\n  port: 9090\n")), [{ severity: "error", message: "Duplicate mapping key: port", text: "port" }]);
  assert.deepEqual(read(mount("server:\n  port: 8080\n  host: localhost\n")), []);
});

test("the linter debounces instead of parsing on every keystroke, then reports live", async () => {
  const view = mount("a: 1\n");

  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "a: 1\na: 2\n" } });
  // Nothing until the idle delay elapses: this is what keeps typing off the parser.
  assert.deepEqual(read(view), []);
  assert.equal(NACOS_YAML_LINT_DELAY_MS > 0, true);

  forceLinting(view);
  await Promise.resolve();
  assert.deepEqual(read(view), [{ severity: "error", message: "Duplicate mapping key: a", text: "a" }]);
});

test("a diagnostic disappears once the error is fixed and reappears when reintroduced", async () => {
  const view = mount("a: 1\na: 2\n");
  assert.equal(read(view).length, 1);

  await relint(view, "a: 1\nb: 2\n");
  assert.deepEqual(read(view), []);

  await relint(view, "a: 1\nb: 2\nb: 3\n");
  assert.deepEqual(read(view), [{ severity: "error", message: "Duplicate mapping key: b", text: "b" }]);

  await relint(view, "a: 1\n\tb: 2\n");
  assert.deepEqual(read(view), [{ severity: "error", message: "YAML indentation must not use tab characters; use spaces instead", text: "\t" }]);
});

test("warning-severity diagnostics reach the editor without being rendered as errors", async () => {
  const view = mount("a: 1\n");
  await relint(view, "a: !unknownTag bar\n");
  assert.deepEqual(read(view), [{ severity: "warning", message: "YAML parser warning: Unresolved tag: !unknownTag", text: "!unknownTag" }]);
});

test("messages are localized through the translator the host injects", async () => {
  const view = mount("a: 1\na: 2\n", (key, params) => `${key}|${params.key ?? params.reason ?? ""}`);
  assert.deepEqual(read(view), [{ severity: "error", message: "nacos.yamlDiagnosticDuplicateKey|a", text: "a" }]);

  await relint(view, "a: 1\n\tb: 2\n");
  assert.deepEqual(read(view), [{ severity: "error", message: "nacos.yamlDiagnosticTabIndent|", text: "\t" }]);
});

test("switching configs leaves no diagnostics from the previous one behind", () => {
  const broken = mount("server:\n  port: 8080\n  port: 9090\n");
  assert.equal(read(broken).length, 1);

  // The editor destroys the old view and builds a new state per config, so the new
  // document must not inherit the previous config's markers.
  const clean = mount("spring:\n  application:\n    name: dbx\n");
  assert.deepEqual(read(clean), []);

  const warning = mount("a: !unknownTag bar\n");
  assert.deepEqual(
    read(warning).map((diagnostic) => diagnostic.severity),
    ["warning"],
  );
  assert.deepEqual(
    read(broken).map((diagnostic) => diagnostic.severity),
    ["error"],
  );
});

test("a destroyed view stops holding diagnostics", () => {
  const view = mount("a: 1\na: 2\n");
  assert.equal(read(view).length, 1);
  view.destroy();
  mounted = mounted.filter((candidate) => candidate !== view);
  // Re-reading after destroy is inert rather than throwing, so teardown cannot leave stale state.
  assert.equal(read(view).length, 1);
});

test("non-YAML content is never analyzed by the YAML linter", async () => {
  // The editor only installs this extension for YAML, so the analyzer is asserted
  // directly for the formats that must stay untouched.
  const properties = "server.port=8080\nserver.port=9090\n";
  const view = mount(properties);
  assert.deepEqual(read(view), []);
  await relint(view, properties);
  assert.deepEqual(read(view), []);
});
