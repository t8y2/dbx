// Source-contract guard for the ErrorBanner "centered" variant (the query
// execution error panel rendered by DataGrid).

// Overview: the centered banner is the only scroll surface for execution
// errors — every ancestor up the results pane is overflow-hidden (DataGrid
// root and content cell, splitpanes pane), so the pane height must reach the
// message box through the flex chain (banner root `flex-1 min-h-0`). A fixed
// `max-h-*` cap on the message box breaks that chain: long error text gets
// clipped at the cap, and in a short pane the tiny internal scrollbar is
// clipped out of view entirely — see #7960 (错误信息面板无法展示完整错误信息).
//
// These guarantees are what stop that from re-happening:
//   1. The message box keeps `min-h-0` (the flex-shrink enabler) and
//      `overflow-y-auto` (the internal scroller) with NO fixed max-height.
//   2. The message text keeps `whitespace-pre-wrap break-words`: backend
//      errors are multi-line ("summary\n\ndetail"); `break-all` collapsed
//      those newlines into a dense wall of text, and without wrap guards a
//      long token could force horizontal overflow.
// If either is removed, the clipping regresses. Keep these assertions updated
// alongside the component whenever the class strings are touched.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const errorBannerSource = readFileSync(new URL("../ErrorBanner.vue", import.meta.url), "utf8");

describe("ErrorBanner centered layout guard", () => {
  it("bounds the centered message box by the flex chain, not a fixed max-height", () => {
    // The box must stay shrinkable in both axes (`min-h-0 min-w-0`) and scroll internally
    // (`overflow-y-auto`); a fixed `max-h-48` cap re-introduces #7960.
    expect(errorBannerSource).toContain('class="min-h-0 min-w-0 max-w-lg overflow-y-auto space-y-1 select-text text-destructive"');
    expect(errorBannerSource).not.toContain("max-h-48");
  });

  it("preserves backend error newlines and wraps long tokens", () => {
    // `text-left` keeps multi-line errors scannable under the centered
    // variant's inherited `text-center` (single-line messages are unaffected:
    // the box hugs its content).
    expect(errorBannerSource).toContain("text-xs whitespace-pre-wrap break-words text-left cursor-text");
  });
});
