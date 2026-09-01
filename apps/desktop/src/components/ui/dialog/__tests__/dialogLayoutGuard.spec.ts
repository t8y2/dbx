// Source-contract guard for the shared dialog layout primitives.

// Overview: `DialogContent` renders a single-column CSS grid (no explicit
// `grid-template-columns`). By default a grid's implicit track sizes to the
// *max-content* of its children, so any child with a large min-content (e.g. a
// footer that lays out many `whitespace-nowrap` buttons on one line) can push
// the track wider than the dialog's `max-w-*`. The dialog's `overflow-hidden`
// then clips the right edge without any scrollbar or ellipsis — see #7325
// (Update dialog clips release notes and buttons on wide locales).
//
// These two guarantees are what stop that from re-happening:
//   1. `grid-cols-[minmax(0,1fr)]` pins the track to the dialog's available
//      width and lets grid items shrink (equivalent to `min-width: 0`).
//   2. `sm:flex-wrap` on the footer lets a long row of buttons wrap instead of
//      forcing the track wide.
// If either is removed, the clipping regresses. Keep these assertions updated
// alongside the components whenever the class strings are touched.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogContentSource = readFileSync(new URL("../DialogContent.vue", import.meta.url), "utf8");
const dialogFooterSource = readFileSync(new URL("../DialogFooter.vue", import.meta.url), "utf8");

describe("dialog layout guard", () => {
  it("pins the DialogContent grid track to the dialog width so children can shrink", () => {
    // The base class (before `props.class`) must lock the implicit track to the
    // available width. Without this, a wide grid item re-expands the track beyond
    // `max-w-*` and the dialog's `overflow-hidden` clips content (issue #7325).
    expect(dialogContentSource).toContain("relative grid grid-cols-[minmax(0,1fr)]");
    // Keep it on the shared base class, not a per-dialog override, so every dialog
    // that reuses DialogContent is protected.
    expect(dialogContentSource).toMatch(/'[^']*relative grid grid-cols-\[minmax\(0,1fr\)\]/);
  });

  it("lets the dialog footer wrap so a row of buttons does not widen the track", () => {
    // At the sm breakpoint the footer is a no-wrap row; a long label (e.g. the
    // Spanish "Descargar e instalar") plus other actions then overflows. Wrapping
    // keeps the footer's min-content down to one button, which in turn keeps the
    // `minmax(0,1fr)` track inside the dialog.
    expect(dialogFooterSource).toMatch(/flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end/);
  });
});
