import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "vue/compiler-sfc";
import ts from "typescript";

const docsRoot = path.resolve(__dirname, "..");

function filesWithExtension(extension: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "__tests__" && entry.name !== "fixtures") {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        found.push(full);
      }
    }
  };
  walk(docsRoot);
  return found;
}

function vueFiles(): string[] {
  return filesWithExtension(".vue");
}

// Every pure module beside the components — docsIndex.ts, docsSearch.ts,
// docsWarnings.ts, and so on. "(no group)" lived in one of these
// (docsIndex.ts) and was invisible to the guard below until this existed:
// that guard only ever walked .vue files, so a literal that never touches a
// template — only a data field a template later reads — was outside its
// reach entirely.
function tsFiles(): string[] {
  return filesWithExtension(".ts");
}

/**
 * Every namespace-key VALUE currently spelled out in en.ts, long enough and
 * plain enough to check for. Shared by both the .vue and .ts scans below so
 * there is exactly one definition of "what counts as a hardcoded literal" —
 * not two lists that can drift out of step with each other.
 */
async function namespaceLiterals(): Promise<string[]> {
  const en = (await import("../../i18n/locales/docs/en")).default as Record<string, unknown>;
  const literals: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      // Skip short strings (false positives on words like "LOCAL") and any
      // string carrying a placeholder, which cannot appear verbatim anyway.
      if (node.length >= 4 && !node.includes("{")) literals.push(node);
      return;
    }
    if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(en);
  return literals;
}

function scriptOf(file: string): string {
  const { descriptor } = parse(readFileSync(file, "utf8"), { filename: file });
  return `${descriptor.script?.content ?? ""}\n${descriptor.scriptSetup?.content ?? ""}`;
}

/**
 * Splits a component's template into the two channels that can actually
 * reach the reader as text: static text between tags, and the JS
 * expressions inside `{{ }}` interpolations. Attribute values (`:class="…"`,
 * `:title="…"`) are deliberately excluded — see the guard below for why.
 *
 * The two channels get different treatment below: `staticText` is scanned
 * with plain substring matching, because it can't contain anything but
 * literal characters. `interpolations` holds JS, where a bare identifier
 * (`table.viewDefinition`, `snapshot.project.databaseType`) can innocently
 * contain a locale word as a substring — only a *quoted* occurrence
 * (`"literal"` or `'literal'`) inside an expression counts as hardcoded copy.
 */
function domTextOf(file: string): { staticText: string; interpolations: string[] } {
  const { descriptor } = parse(readFileSync(file, "utf8"), { filename: file });
  const template = descriptor.template?.content ?? "";
  // Comments are prose, not display text, and can otherwise trip a
  // substring match by coincidence (a comment mentioning "the note" would
  // false-positive on the `noteHeader` key).
  const withoutComments = template.replace(/<!--[\s\S]*?-->/g, "");

  const interpolations: string[] = [];
  const withoutInterpolations = withoutComments.replace(/{{([\s\S]*?)}}/g, (_match, expr) => {
    interpolations.push(expr);
    return "";
  });

  // Whatever sits between a tag's closing `>` and the next `<` is DOM text;
  // whatever sits before that `>`, inside the tag itself, is an attribute
  // and mostly doesn't render as visible text — so this intentionally
  // doesn't look there on purpose. "Mostly" because the split is a regex,
  // not a parser: an attribute value containing a bare `>` (a comparison
  // like `v-if="count > 0"`) ends the match early and leaks the tail of
  // that attribute into a segment. That leak runs in the safe direction —
  // it can only add text to scan, never drop real display text — so the
  // risk is a false positive below, never a missed literal.
  const segments: string[] = [];
  for (const match of withoutInterpolations.matchAll(/>([^<]*)</g)) {
    segments.push(match[1]);
  }
  return { staticText: segments.join(" "), interpolations };
}

/**
 * Every string literal in a .ts file that could become a runtime VALUE —
 * and, from there, reach a template as display text, exactly how
 * docsIndex.ts's `label: "(no group)"` did. Excludes string literals in TYPE
 * position, e.g. `type NoteSource = "DATABASE" | "LOCAL" | "NONE"`: those
 * disappear at compile time and can never be displayed, so flagging them
 * would be the .ts equivalent of the `=== 'LOCAL'` false positive from the
 * last round. `ts.isLiteralTypeNode` is TypeScript's own distinction
 * between the two, not a hand-picked exception — the same check the
 * compiler itself uses to know it is looking at a type, not a value.
 *
 * Unlike domTextOf's split of display-vs-comparison text, this collects
 * every value-position literal with no such distinction — a literal used
 * only in a comparison (`type === "LOCAL"`) is indistinguishable here from
 * one that reaches a template as display text. Accepted as this scan's
 * blind spot rather than chased, for the same reason: the risk is a false
 * positive, not a missed literal.
 */
function valueStringLiteralsOf(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && !ts.isLiteralTypeNode(node.parent)) {
      literals.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return literals;
}

const EXPECTED = ["ColumnTable.vue", "DocsApp.vue", "DocsSearch.vue", "DocsSidebar.vue", "EnumPage.vue", "GroupEditor.vue", "GroupPicker.vue", "NoteEditor.vue", "RelationshipList.vue", "SchemaDiagram.vue", "TablePage.vue", "WarningBanner.vue", "WikiIndex.vue"];

describe("docs viewer component contract", () => {
  it("finds every expected component", () => {
    expect(
      vueFiles()
        .map((file) => path.basename(file))
        .sort(),
    ).toEqual(EXPECTED);
  });

  // Every test below loops over vueFiles(). On an empty set those loops run zero
  // assertions and pass while proving nothing, so each one asserts the set is
  // populated first. Without this, deleting every component turns the whole
  // contract green.
  it("makes no backend calls", () => {
    const files = vueFiles();
    expect(files.length).toBe(EXPECTED.length);
    // vue-i18n belongs here for the same reason as the backend imports: these
    // components are bundled into a standalone HTML file with no Vue app
    // around them, and useI18n() throws without a provided instance. Strings
    // arrive as a `translate` prop from the host instead.
    const forbidden = ["@/lib/backend", "@tauri-apps", "invoke(", "useConnectionStore", "useQueryStore", "useSettingsStore", "fetch(", "axios", "vue-i18n", "useI18n("];
    for (const file of files) {
      const script = scriptOf(file);
      for (const needle of forbidden) {
        expect(script.includes(needle), `${path.basename(file)} must not reference ${needle}`).toBe(false);
      }
    }
  });

  it("keeps colour decisions out of templates", () => {
    const files = vueFiles();
    expect(files.length).toBe(EXPECTED.length);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source.includes("oklch("), `${path.basename(file)} must not compute colour`).toBe(false);
      expect(/#[0-9a-fA-F]{6}\b/.test(source), `${path.basename(file)} must not hardcode a hex colour`).toBe(false);
    }
  });

  it("only ever feeds renderNote output to v-html", () => {
    // The single most dangerous thing a template here can do. Task 7 escapes
    // author HTML, but `v-html="table.note"` bypasses it entirely and hands a
    // COMMENT ON value straight to the DOM. Every v-html binding must name
    // renderNote, and no component may build HTML any other way.
    const files = vueFiles();
    expect(files.length).toBe(EXPECTED.length);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      // Either quote style. A double-quote-only pattern finds zero matches in
      // `v-html='table.note'` and passes it, which is the exact binding this
      // test exists to catch.
      for (const match of source.matchAll(/v-html\s*=\s*(["'])(.*?)\1/g)) {
        expect(match[2], `${path.basename(file)}: v-html must render renderNote output`).toContain("renderNote");
      }
      expect(source.includes("innerHTML"), `${path.basename(file)} must not touch innerHTML`).toBe(false);
    }
  });

  it("the viewer emits edits rather than persisting them", () => {
    // src/docs/ must stay free of I/O so Part 3c can bundle it. Editing works
    // by emitting upward; the dialog outside this directory does the saving.
    const files = vueFiles();
    expect(files.length).toBe(EXPECTED.length);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const needle of ["saveDocsAnnotations", "loadDocsAnnotations", "applyDocsAnnotations"]) {
        expect(source.includes(needle), `${path.basename(file)} must not call ${needle}`).toBe(false);
      }
    }
  });

  it("editing components accept a readonly mode", () => {
    // Part 3c renders these same components with editing off inside an
    // exported HTML file. A component that cannot be made read-only would
    // have to be forked for the export.
    const files = vueFiles();
    expect(files.length).toBe(EXPECTED.length);
    const editors = files.filter((file) => path.basename(file) === "NoteEditor.vue");
    expect(editors.length).toBe(1);
    expect(readFileSync(editors[0], "utf8")).toContain("readonly");
  });

  it('uses <script setup lang="ts">', () => {
    const files = vueFiles();
    expect(files.length).toBe(EXPECTED.length);
    for (const file of files) {
      const { descriptor } = parse(readFileSync(file, "utf8"), { filename: file });
      expect(descriptor.scriptSetup, `${path.basename(file)} must use <script setup>`).toBeTruthy();
      expect(descriptor.scriptSetup?.lang, `${path.basename(file)} must be TypeScript`).toBe("ts");
    }
  });

  it("defines the group colour tokens for WebViews without oklch", () => {
    // DBX supports legacy WebViews with no oklch (globals.css carries an
    // `@supports not (color: oklch(...))` block). The repo's convention is
    // progressive enhancement: a legacy-safe base value first, then the same
    // token redefined inside `@supports (color: oklch(1 0 0))`. Without the
    // base, every table group renders colourless on those WebViews.
    //
    // Assert each selector's base block separately. An ordering check like
    // `indexOf(hsl) < indexOf(@supports)` quantifies over ANY occurrence, so
    // deleting the light block leaves the dark block's hsl satisfying it — the
    // test passes while light-theme legacy WebViews render every group
    // colourless.
    //
    // `.docs-ground-light` is here for the same reason as the other two, not as
    // a third theme: GroupEditor previews a hue on a light ground whatever the
    // app's theme, so that ground needs its own legacy-safe base. Without this
    // entry the whole block could be deleted with the suite still green, and
    // the preview would quietly show dark-theme colours on white in dark mode.
    const css = readFileSync(path.join(docsRoot, "docs.css"), "utf8");
    const enhanced = css.indexOf("@supports (color: oklch(1 0 0))");
    expect(enhanced).toBeGreaterThan(-1);
    const legacyBase = css.slice(0, enhanced);

    for (const selector of [".docs-group", ".dark .docs-group", ".docs-ground-light .docs-group"]) {
      // `^` with the m flag anchors to a line start, so `.docs-group` cannot
      // match inside `.dark .docs-group`, and neither matches the indented
      // copies inside the @supports block.
      const pattern = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
      const block = pattern.exec(legacyBase)?.[1];
      expect(block, `${selector} needs a legacy-safe base block before @supports`).toBeTruthy();
      expect(block, `${selector} must define --group-c without oklch`).toContain("--group-c: hsl(");
      expect(block, `${selector} must define --group-tint without oklch`).toContain("--group-tint: hsl(");
    }
  });

  it("renders no English literal that already has a key", async () => {
    // Derived from the namespace, NOT an enumerated list of strings. A key
    // added tomorrow is covered tomorrow. This is the guard Part 3b lacked:
    // docsNamespaceParity compares locale files to EACH OTHER, so a key that
    // no component ever calls passes every existing test.
    const literals = await namespaceLiterals();
    expect(literals.length).toBeGreaterThan(10);

    const files = vueFiles();
    expect(files.length).toBe(EXPECTED.length);
    for (const file of files) {
      // Deliberately scoped to what reaches the DOM as text — see domTextOf
      // — rather than the whole file. Two earlier, narrower shapes of this
      // same guard both ran green over a real defect: matching only
      // `>literal<` misses a literal buried in a JS fallback
      // (`section.label || "(no schema)"`, DocsSidebar.vue/WikiIndex.vue);
      // matching any quoted occurrence anywhere in the template misses
      // nothing display-related but flags plenty that isn't — a bare
      // identifier like `table.viewDefinition` or
      // `snapshot.project.databaseType` shares a substring with a locale
      // word purely by accident, and an attribute-only comparison like
      // `noteOf(column)?.source === 'LOCAL'` tests data, not copy.
      const { staticText, interpolations } = domTextOf(file);
      for (const literal of literals) {
        // Static text, e.g. `>Overview<` or `>⬤ LOCAL<` — anything literally
        // written between tags is definitionally display text, so a plain
        // substring match is safe here.
        expect(staticText.includes(literal), `${path.basename(file)} hardcodes "${literal}" — call translate() instead`).toBe(false);
        // A JS expression inside a `{{ }}` mustache, e.g.
        // `section.label || "(no schema)"`. Only a *quoted* occurrence
        // counts — an unquoted one is a property/variable name, not copy.
        expect(
          interpolations.some((expr) => expr.includes(`"${literal}"`) || expr.includes(`'${literal}'`)),
          `${path.basename(file)} hardcodes "${literal}" in a template expression — call translate() instead`,
        ).toBe(false);
      }
    }
    // Known gap, accepted rather than chased: a literal passed to an
    // attribute binding — `:title="'Hardcoded text'"` — can still reach the
    // reader (as a tooltip, an aria-label, …) and this guard does not see
    // it, because attribute values are excluded by design to avoid the
    // data-comparison false positives above. If a future defect turns out
    // to live in an attribute, that's this guard's known blind spot, not a
    // regression in it.

    // The pure modules beside the components — docsIndex.ts's
    // `label: "(no group)"` was exactly this: a literal that never touches a
    // template directly, only a data field a template reads later. A .vue-only
    // scan is structurally blind to it no matter how the .vue scan itself is
    // shaped, so this is a second, independent walk over a different file
    // extension rather than a wider regex over the same one.
    const tsSourceFiles = tsFiles();
    expect(tsSourceFiles.length).toBeGreaterThan(0);
    for (const file of tsSourceFiles) {
      const valueLiterals = valueStringLiteralsOf(file);
      for (const literal of literals) {
        expect(valueLiterals.includes(literal), `${path.basename(file)} hardcodes "${literal}" — call translate() instead`).toBe(false);
      }
    }
  });
});
