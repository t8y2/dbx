import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const browserSource = readFileSync(new URL("../KvKeyBrowser.vue", import.meta.url), "utf8");
const valueEditorSource = readFileSync(new URL("../KvValueEditor.vue", import.meta.url), "utf8");

describe("KvKeyBrowser edit dialog layout", () => {
  it("keeps the value format label and selector together in the editor toolbar", () => {
    expect(browserSource).toContain('class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"');
    expect(browserSource).toContain('class="flex shrink-0 items-center gap-3"');
    expect(browserSource).toContain('<SelectTrigger class="h-9 w-44">');
  });

  it("cancels the shared footer negative margin and preserves bottom safe spacing", () => {
    expect(browserSource).toContain('<DialogFooter class="mx-0 mb-0 shrink-0 gap-3 border-t bg-muted/10 px-6 py-5">');
    expect(browserSource).toContain('variant="outline" class="h-10 min-w-20"');
    expect(browserSource).toContain('<Button class="h-10 min-w-20" :disabled="saving || readOnly"');
  });

  it("applies the same safe spacing to the history dialog footer", () => {
    expect(browserSource).toContain('<DialogFooter class="mx-0 mb-0 shrink-0 border-t px-6 py-5">');
    expect(browserSource).toContain('class="h-10 min-w-20" @click="showHistoryDialog = false"');
  });

  it("keeps an accessible copy action in the upper-right corner of the value panel", () => {
    expect(browserSource).toContain('class="absolute right-2 top-2 z-10 h-8 w-8');
    expect(browserSource).toContain('@click="copySelectedValue"');
    expect(browserSource).toContain('<Check v-if="selectedValueCopied"');
    expect(browserSource).toContain('<Copy v-else class="h-4 w-4" />');
    expect(browserSource).toMatch(/<pre\s+data-native-clipboard/);
  });

  it("keeps the selected value preview word wrapping aligned with the global editor setting", () => {
    expect(browserSource).toContain(":class=\"settingsStore.editorSettings.wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'\"");
    expect(browserSource).not.toContain("bg-muted/20 whitespace-pre-wrap break-words p-3");
  });

  it("keeps shared KV value editor word wrapping aligned with the global editor setting", () => {
    expect(valueEditorSource).toContain("const wordWrapCompartment = new Compartment()");
    expect(valueEditorSource).toContain("wordWrapCompartment.of(wordWrapExtension())");
    expect(valueEditorSource).toContain("wordWrapCompartment.reconfigure(wordWrapExtension(wordWrap))");
    expect(valueEditorSource).not.toContain("\n        EditorView.lineWrapping,\n");
  });
});
