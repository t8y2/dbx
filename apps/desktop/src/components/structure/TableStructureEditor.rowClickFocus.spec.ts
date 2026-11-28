// @vitest-environment happy-dom

/**
 * #15585 — the structure grid moved focus to the column scroller on every row
 * click so the row clipboard shortcuts work. A click on a dropdown trigger pulled
 * focus out of the control, and reka's popover / dropdown layers dismiss on
 * `focus-outside`, so the type / default-value / comment pickers closed in the
 * same tick they opened ("闪一下就关闭").
 *
 * The predicate itself is covered by
 * `lib/__tests__/table/structureRowClickFocus.spec.ts`; this pins the wiring so the
 * focus move cannot come back for control targets.
 */

import { describe, expect, it } from "vitest";
import editorSource from "./TableStructureEditor.vue?raw";
import { STRUCTURE_ROW_FOCUS_OWNING_CONTROL_SELECTOR } from "@/lib/table/structureRowClickFocus";

function onColumnRowClickSource(): string {
  const start = editorSource.indexOf("function onColumnRowClick(");
  const end = editorSource.indexOf("\n}\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return editorSource.slice(start, end);
}

describe("table structure editor row click focus (#15585)", () => {
  it("only moves focus to the scroller when the click target does not own focus", () => {
    const source = onColumnRowClickSource();

    expect(source).toContain("structureScrollerElement(columnsScrollerRef.value)?.focus({ preventScroll: true })");
    expect(source).toContain("!structureRowClickTargetOwnsFocus(event.target)");
  });

  it("keeps the native-clipboard exemption for text fields", () => {
    expect(onColumnRowClickSource()).toContain("!eventTargetUsesNativeClipboard(event)");
  });

  it("treats every overlay trigger shape as a focus-owning control", () => {
    expect(editorSource).toMatch(/import \{[^}]*\bstructureRowClickTargetOwnsFocus\b[^}]*\} from "@\/lib\/table\/structureRowClickFocus";/);
    for (const shape of ["button", "[aria-haspopup]", "[role='combobox']"]) {
      expect(STRUCTURE_ROW_FOCUS_OWNING_CONTROL_SELECTOR).toContain(shape);
    }
  });
});
