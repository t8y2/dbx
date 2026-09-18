import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");

// The shortcuts tab groups its 78 actions by scope (global → editor → grid →
// search → sidebar) and reports conflicts on two levels:
//   · same-scope duplicates  → blocking (Apply stays disabled, pill turns red)
//   · cross-scope same chord → informational only (thin amber pill border)
// These assertions pin the load-bearing parts of that split: cross-scope
// overlaps must never reach the apply gate, the group order must keep matching
// the runtime dispatch order, and the L1 red must win over the L2 amber.
describe("EditorSettingsDialog shortcut scope grouping", () => {
  const shortcutsTab = dialogSource.slice(dialogSource.indexOf("activeSettingsTab === 'shortcuts'"), dialogSource.indexOf('data-settings-search-id="sql-shortcuts"'));

  it("groups the shortcuts tab by scope and drops the per-row scope badge", () => {
    expect(shortcutsTab).toContain('v-for="group in shortcutScopeGroups"');
    expect(shortcutsTab).toContain(':is="shortcutScopeIcon(group.scope)"');
    // The scope chip moved into the group header; rows must not repeat it
    // (the template literal lookup used by the old row badge is gone).
    expect(dialogSource).not.toContain("shortcutScope${definition.scope");
  });

  it("keeps the group order equal to the runtime dispatch order", () => {
    const order = dialogSource.slice(dialogSource.indexOf("const SHORTCUT_SCOPE_ORDER"), dialogSource.indexOf("function shortcutScopeLabelKey"));
    expect(order).toContain('["global", "editor", "grid", "search", "sidebar"]');
  });

  it("keeps same-scope conflicts blocking and cross-scope overlaps informational", () => {
    // L1 comes from findShortcutConflict only…
    const conflictMap = dialogSource.slice(dialogSource.indexOf("const shortcutConflictMap = computed"), dialogSource.indexOf("const shortcutConflicts = computed(() => Object.keys"));
    expect(conflictMap).toContain("findShortcutConflict(");
    expect(conflictMap).not.toContain("findCrossScopeShortcutConflicts");
    // …and the apply gate must not learn about the cross-scope tier.
    const blocker = dialogSource.slice(dialogSource.indexOf("const hasBlockingShortcutConflicts = computed"), dialogSource.indexOf("const hasBlockingFormatterConfig"));
    expect(blocker).toContain("hasShortcutConflicts.value || hasSqlShortcutConflicts.value");
    expect(blocker).not.toContain("crossScope");
  });

  it("explains a disabled Apply in the footer now that rows carry no inline message", () => {
    expect(dialogSource).toContain('v-if="hasBlockingShortcutConflicts"');
    expect(dialogSource).toContain('t("settings.shortcutConflictBlocksApply"');
    expect(shortcutsTab).not.toContain('{{ t("settings.shortcutConflict") }}');
    expect(shortcutsTab).toContain(':text="shortcutConflictHintText(definition)"');
  });

  it("lets the blocking red win over the informational amber on the pill", () => {
    // Both states tint the same pill; the cross-scope rule must exclude
    // aria-invalid rows, otherwise a row that is both would render amber.
    expect(dialogSource).toContain('.settings-shortcut-row[data-cross-scope="true"] .settings-shortcut-pill:not([aria-invalid="true"])');
    expect(dialogSource).toContain("border-color: color-mix(in srgb, var(--warning) 45%, transparent);");
  });

  it("keeps the capture pill's measured-width contract untouched", () => {
    // The non-editing pill branch is a separate, deliberate formula (see
    // .trellis/spec/dbx/frontend/keyboard-shortcuts.md, contract 5) — do not
    // unify it with the measured capture-input width.
    expect(shortcutsTab).toContain("Math.max(4, formatShortcutPill(editShortcuts[definition.id]).length + 3)}ch");
    expect(shortcutsTab).toContain("editingShortcutId === definition.id ? shortcutPressShortcutInputWidth");
  });
});
