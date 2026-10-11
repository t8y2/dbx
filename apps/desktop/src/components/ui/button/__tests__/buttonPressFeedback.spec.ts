// Source-contract guard for shared button press feedback.

// Overview: desktop click responsiveness depends on buttons giving immediate
// visual feedback while pressed. DOM `click` only fires on pointer-up, so a
// press with zero visual delta reads as "the click did nothing" and users
// retry or hold the button (~1s holds measured in click-probe sessions).
//
// Two guarantees keep that regression from re-appearing:
//   1. Every button variant styles an `active:` pressed state, so pressing
//      always changes something on screen before pointer-up.
//   2. The pressed state must not move or scale the button (`scale-*` /
//      `translate-*`). A moving hit target can land pointer-up outside the
//      element it was pressed on, which genuinely drops the click.
// Keep these assertions updated alongside the variant class strings.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const buttonVariantsSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

const VARIANTS = ["default", "outline", "secondary", "ghost", "destructive", "link"] as const;

function variantClasses(variant: string): string {
  const match = buttonVariantsSource.match(new RegExp(`${variant}:\\s*"([^"]+)"`));
  expect(match, `variant "${variant}" exists in buttonVariants`).toBeTruthy();
  return match![1];
}

describe("button press feedback guard", () => {
  it.each(VARIANTS)("styles an active pressed state for the %s variant", (variant) => {
    expect(variantClasses(variant)).toMatch(/(^|\s)active:/);
  });

  it.each(VARIANTS)("does not move the hit target while %s is pressed", (variant) => {
    expect(variantClasses(variant)).not.toMatch(/active:(scale|translate|-translate)-/);
  });

  it("does not move the hit target from the shared base classes", () => {
    const base = buttonVariantsSource.match(/cva\(\s*"([^"]+)"/);
    expect(base).toBeTruthy();
    expect(base![1]).not.toMatch(/active:(scale|translate|-translate)-/);
  });
});
