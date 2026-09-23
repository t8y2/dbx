import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for the AI status ring on the scroll-to-bottom button:
//
// While a run is active for the visible conversation (`isGenerating`), the
// scroll-to-bottom button must stay visible even when the user is already at
// the bottom, and must render a decorative rotating arc ring (an "assistant is
// working" marker, Si-Octo-style). The ring is aria-hidden decoration driven
// purely by `isGenerating` — the scroll-driven hysteresis (`showScrollToBottom`
// + the MESSAGE_SCROLL_BUTTON_* thresholds) must stay the single source of the
// scroll path, and clicking must still force-scroll to the bottom.
//
// AiAssistant.vue is a ~6000-line SFC the suite never mounts (see
// .trellis/spec/app-tests/frontend/component-guidelines.md): these assertions
// pin the template wiring as text, matching the house source-assertion style.
const source = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");

const buttonMatch = source.match(/<button[^>]*v-if="showScrollToBottom \|\| isGenerating"[\s\S]*?<\/button>/);

function buttonEl(): string {
  if (!buttonMatch) {
    throw new Error('scroll-to-bottom button gated on "showScrollToBottom || isGenerating" not found in AiAssistant.vue');
  }
  return buttonMatch[0];
}

describe("AI assistant scroll-to-bottom button status ring", () => {
  it("keeps the button visible while a run is active, not only when scrolled away", () => {
    expect(buttonEl()).toContain('v-if="showScrollToBottom || isGenerating"');
  });

  it("renders the decorative rotating arc ring only while generating", () => {
    const button = buttonEl();
    const ring = button.match(/<svg[\s\S]*?<\/svg>/);
    if (!ring) throw new Error("expected the inline status-ring <svg> inside the scroll-to-bottom button");
    const ringEl = ring[0];
    expect(ringEl).toContain('v-if="isGenerating"');
    // Decorative: flagged for tests/e2e, excluded from the accessibility tree.
    expect(ringEl).toContain("data-ai-scroll-ring");
    expect(ringEl).toContain('aria-hidden="true"');
    // House spinner idiom + the firm prefers-reduced-motion opt-out convention.
    expect(ringEl).toContain("animate-spin");
    expect(ringEl).toContain("motion-reduce:animate-none");
    // Semantic token color — theme/dark-mode support comes free via currentColor.
    expect(ringEl).toContain("text-primary");
    // The ring must never swallow clicks, and fill="none" keeps the open arc
    // from rendering as a filled pie slice.
    expect(ringEl).toContain("pointer-events-none");
    expect(ringEl).toContain('fill="none"');
    // Open ~288° arc (statement-gutter spinner geometry scaled to the 32-unit
    // ring box), round-capped like every other arc/spinner in the repo.
    expect(ringEl).toContain("M29 16a13 13 0 1 1-8.98-12.36");
    expect(ringEl).toContain('stroke-linecap="round"');
  });

  it("keeps the force scroll-to-bottom behavior and the arrow icon intact", () => {
    const button = buttonEl();
    expect(button).toContain("scrollToBottom({ force: true })");
    expect(button).toContain("<ArrowDown");
    expect(button).toContain('t("ai.scrollToBottom")');
  });

  it("leaves the scroll hysteresis thresholds untouched", () => {
    // Visibility is an OR over the existing state machine; the thresholds must
    // remain the single source of the scroll-driven path (show 120 > hide 48).
    expect(source).toContain("MESSAGE_SCROLL_BUTTON_SHOW_THRESHOLD_PX = 120;");
    expect(source).toContain("MESSAGE_SCROLL_BUTTON_HIDE_THRESHOLD_PX = 48;");
  });
});
