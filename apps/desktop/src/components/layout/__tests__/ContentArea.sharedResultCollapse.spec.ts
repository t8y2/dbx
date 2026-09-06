import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contentAreaSource = readFileSync(new URL("../ContentArea.vue", import.meta.url), "utf8");

describe("ContentArea shared result pane collapse (#8233)", () => {
  it("renders the results toolbar (and its hide-results chevron) even with no query output when resultOnly", () => {
    // The shared result surface (QueryResultSurface -> ContentArea result-only)
    // is mounted unconditionally by SqlEditorWorkspace regardless of whether the
    // active tab has run a query. handleHideResultsPane's chevron lives inside
    // this toolbar and is the only UI to collapse that shared pane, so gating
    // the toolbar on hasQueryOutput alone left it permanently open with no way
    // to close it until a query executed.
    expect(contentAreaSource).not.toMatch(/v-if="hasQueryOutput"\s+class="flex h-10 shrink-0 items-center gap-1 border-b bg-muted\/20 px-2"/);
    expect(contentAreaSource).toContain(`v-if="hasQueryOutput || resultOnly" class="flex h-10 shrink-0 items-center gap-1 border-b bg-muted/20 px-2"`);
  });

  it("keeps handleHideResultsPane bubbling a toggle event for the shared (resultOnly) surface", () => {
    expect(contentAreaSource).toContain('if (props.resultOnly) {\n    emit("toggleResultsPane");');
  });
});
