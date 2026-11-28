import { readFileSync } from "node:fs";
import { parse } from "vue/compiler-sfc";
import { describe, expect, it } from "vitest";

// While the SQL editor host was a percentage-sized flex child (`h-full w-full`),
// every selection change made the browser's Selection.collapse force a
// synchronous layout of the whole app: ~10 ms per cursor move or drag-selection
// step in WKWebView, independent of the document size. Taking the host out of
// flow with definite insets makes it a layout boundary (~1 ms) and leaves the
// rendered geometry unchanged.
describe("SQL editor host layout", () => {
  const template = parse(readFileSync(new URL("../QueryEditor.vue", import.meta.url), "utf8")).descriptor.template?.content ?? "";
  const host = template.match(/<div\s+ref="editorRef"[^>]*?class="([^"]*)"/)?.[1].split(/\s+/) ?? [];
  const wrapper = template.match(/<div class="([^"]*)">\s*<QueryEditorContextMenu/)?.[1].split(/\s+/) ?? [];

  it("finds the editor host and its wrapper", () => {
    expect(host).toContain("overflow-hidden");
    expect(wrapper).toContain("flex-1");
  });

  it("keeps the host out of flow instead of percentage-sized", () => {
    expect(host).toEqual(expect.arrayContaining(["absolute", "inset-0"]));
    expect(host).not.toContain("h-full");
    expect(host).not.toContain("w-full");
  });

  it("keeps the wrapper positioned so the insets resolve against it", () => {
    expect(wrapper).toContain("relative");
    expect(wrapper).toContain("min-h-0");
  });
});
