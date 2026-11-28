import { readFileSync } from "node:fs";
import { parse } from "vue/compiler-sfc";
import { describe, expect, it } from "vitest";

// The app root used to be `position: fixed`. In WKWebView that added a second
// window-sized backing store (21 MB at 1440x900 @2x, 56 MB at 2560x1440 @2x), so
// it must stay an ordinary positioned box. `isolate` has to stay with it: `fixed`
// created the stacking context that keeps the -z-10 app background and the root's
// z-index children below the body-level dialog portals.
describe("app root compositing", () => {
  const template = parse(readFileSync(new URL("../App.vue", import.meta.url), "utf8")).descriptor.template?.content ?? "";
  const rootClasses = template.match(/class="([^"]*\bdbx-app-root\b[^"]*)"/)?.[1].split(/\s+/) ?? [];

  it("finds the app root element", () => {
    expect(rootClasses).toContain("dbx-app-root");
  });

  it("is not position: fixed", () => {
    expect(rootClasses).not.toContain("fixed");
    expect(rootClasses).not.toContain("sticky");
  });

  it("is absolutely positioned over the whole viewport in its own stacking context", () => {
    expect(rootClasses).toEqual(expect.arrayContaining(["absolute", "isolate", "inset-0", "h-screen", "w-screen", "overflow-hidden"]));
  });
});
