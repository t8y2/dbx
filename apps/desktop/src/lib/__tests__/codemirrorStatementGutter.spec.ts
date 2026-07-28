// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { createStatementGutterMarkerDom, shouldShowStatementGutter } from "@/lib/editor/codemirrorStatementGutter";

describe("CodeMirror statement gutter marker", () => {
  it("omits the gutter when run buttons and status markers are absent", () => {
    expect(shouldShowStatementGutter(false, 0)).toBe(false);
    expect(shouldShowStatementGutter(true, 0)).toBe(true);
    expect(shouldShowStatementGutter(false, 1)).toBe(true);
  });

  it("keeps execution status inside the run button column", () => {
    const marker = createStatementGutterMarkerDom({
      canExecute: true,
      executeLabel: "Execute SQL",
      status: "success",
      statusLabel: "1 statement succeeded",
    });

    expect(marker.tagName).toBe("BUTTON");
    expect(marker.classList.contains("cm-run-statement-marker")).toBe(true);
    expect(marker.querySelectorAll(".cm-statement-execution-badge--success")).toHaveLength(1);
    expect(marker.getAttribute("aria-label")).toBe("Execute SQL. 1 statement succeeded");
  });

  it("renders a standalone status marker when run buttons are disabled", () => {
    const marker = createStatementGutterMarkerDom({
      canExecute: false,
      executeLabel: "Execute SQL",
      status: "error",
      statusLabel: "1 statement failed",
    });

    expect(marker.tagName).toBe("SPAN");
    expect(marker.classList.contains("cm-statement-execution-marker--error")).toBe(true);
    expect(marker.querySelectorAll(".cm-statement-execution-badge")).toHaveLength(0);
    expect(marker.getAttribute("aria-label")).toBe("1 statement failed");
  });
});
