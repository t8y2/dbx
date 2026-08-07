import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "vue/compiler-sfc";

const docsRoot = path.resolve(__dirname, "..");

function vueFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "__tests__" && entry.name !== "fixtures") {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".vue")) {
        found.push(full);
      }
    }
  };
  walk(docsRoot);
  return found;
}

function scriptOf(file: string): string {
  const { descriptor } = parse(readFileSync(file, "utf8"), { filename: file });
  return `${descriptor.script?.content ?? ""}\n${descriptor.scriptSetup?.content ?? ""}`;
}

const EXPECTED = ["ColumnTable.vue", "DocsApp.vue", "DocsSearch.vue", "DocsSidebar.vue", "EnumPage.vue", "GroupEditor.vue", "GroupPicker.vue", "NoteEditor.vue", "RelationshipList.vue", "TablePage.vue", "WarningBanner.vue", "WikiIndex.vue"];

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
});
