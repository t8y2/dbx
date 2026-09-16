// @vitest-environment happy-dom
// Source-assertion regression for #9144: the shortcut-capture input width must
// come from measuring a hidden mirror span (same box + typography as the real
// inputs), not from `label.length + 2em` char-count arithmetic — CJK fallback
// fonts can advance wider than 1em and clip the last placeholder glyph. The
// dialog cannot be mounted (a 10k-line SFC whose imports pull the whole
// editor + stores), so this follows the same `?raw` pattern as
// EditorSettingsDialog.mcpQueryTimeout.integration.spec.ts.
import { describe, expect, it } from "vitest";
import dialogSource from "../EditorSettingsDialog.vue?raw";

function templateOnly(): string {
  // The root <template> block, not the first "</template>" — this SFC is full
  // of nested slot <template> elements, so the first closing tag (and the
  // naive slice up to it) lands inside the template and misses most of it.
  return dialogSource.slice(dialogSource.search(/^<template>$/m), dialogSource.lastIndexOf("</template>"));
}

describe("EditorSettingsDialog shortcut capture input width (#9144)", () => {
  it("mounts exactly one hidden mirror span carrying the shared typography/box classes", () => {
    const template = templateOnly();

    // The ref token appears exactly once in the template: the mirror span.
    // (The two script occurrences are the ref declaration and the
    // useMeasuredWidth call.)
    expect(template.match(/shortcutPlaceholderMirrorRef/g)).toHaveLength(1);
    expect(dialogSource.match(/shortcutPlaceholderMirrorRef/g)).toHaveLength(3);

    // Same box + typography classes as the capture inputs so the measured
    // border-box width includes padding, border, letter-spacing and
    // fallback-font advances. Asserted against the span's own tag (not the
    // whole template) — the capture inputs share these classes, so a
    // template-wide match would pass even with the span stripped.
    const spanTag = template.match(/<span ref="shortcutPlaceholderMirrorRef"[^>]*>/)?.[0];
    expect(spanTag).toBeTruthy();
    for (const cls of ["font-mono", "text-[13px]", "font-semibold", "px-2.5", "border", "whitespace-pre", "invisible"]) {
      expect(spanTag).toContain(cls);
    }

    // The label must be interpolated in-band with the span tags, not as
    // template text between newlines — whitespace-pre would otherwise widen
    // the measured box.
    expect(template).toMatch(/<span ref="shortcutPlaceholderMirrorRef"[^>]*>\{\{ shortcutPressShortcutLabel \}\}<\/span>/);
  });

  it("binds all three capture inputs to the measured width ref", () => {
    // Two width bindings gate on the row-level editing state (formatter table
    // + shortcuts table), one on the SQL-shortcut dialog editing state. Each
    // conditional token appears in exactly one kind of binding.
    expect(dialogSource.match(/editingShortcutId === definition\.id \? shortcutPressShortcutInputWidth/g)).toHaveLength(2);
    expect(dialogSource.match(/editingSqlShortcutInputId === 'dialog' \? shortcutPressShortcutInputWidth/g)).toHaveLength(1);

    // Account for every usage of the width ref: 1 fallback initializer,
    // 1 watcher application, 3 capture-input bindings.
    expect(dialogSource.match(/shortcutPressShortcutInputWidth/g)).toHaveLength(5);
  });

  it("wires the measured width to the shared mirror ref with the label as revalidate source", () => {
    expect(dialogSource).toContain("useMeasuredWidth(shortcutPlaceholderMirrorRef, 0, [shortcutPressShortcutLabel])");

    // The applied width adds a ~2px cushion and rounds up so sub-pixel
    // rounding never under-sizes.
    expect(dialogSource).toContain("${Math.ceil(width) + 2}px");
  });

  it("keeps the char-count formula only as the ref fallback initializer", () => {
    // The legacy `length + 2em` estimate survives solely as the pre-measurement
    // initializer of the ref.
    expect(dialogSource).toContain("shortcutPressShortcutInputWidth = ref(`${shortcutPressShortcutLabel.value.length + 2}em`)");

    // No computed re-derives the width from char count anymore.
    expect(dialogSource).not.toMatch(/computed\(\(\) => `\$\{shortcutPressShortcutLabel\.value\.length \+ 2\}em`\)/);
  });
});
