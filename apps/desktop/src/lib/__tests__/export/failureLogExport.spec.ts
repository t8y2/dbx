import { describe, expect, it } from "vitest";

import { failureLogKeyPayload, failureLogListCoverage, failureLogRowKey, selectedFailureLogKeys } from "@/lib/export/failureLogExport";

function failure(fileIndex: number | undefined, statementIndex: number, error = "boom") {
  return { statementIndex, statementSummary: `summary ${statementIndex}`, error, fileIndex };
}

describe("failure log export helpers", () => {
  it("keys rows stably whether or not the run had several files", () => {
    expect(failureLogRowKey(failure(2, 644))).toBe("2:644");
    // Single-file runs carry no fileIndex; the key must still be unique.
    expect(failureLogRowKey(failure(undefined, 644))).toBe("-1:644");
  });

  it("maps rows to the backend key payload, defaulting the file index", () => {
    expect(failureLogKeyPayload(failure(1, 7))).toEqual({ fileIndex: 1, statementIndex: 7 });
    expect(failureLogKeyPayload(failure(undefined, 7))).toEqual({ fileIndex: 0, statementIndex: 7 });
  });

  it("keeps the list order when building the selection payload", () => {
    const failures = [failure(0, 1), failure(0, 2), failure(0, 3)];
    const selected = new Set([failureLogRowKey(failures[2]!), failureLogRowKey(failures[0]!)]);

    expect(selectedFailureLogKeys(failures, selected)).toEqual([
      { fileIndex: 0, statementIndex: 1 },
      { fileIndex: 0, statementIndex: 3 },
    ]);
  });

  it("reports how many failures the in-memory list hides", () => {
    expect(failureLogListCoverage(110, 110)).toEqual({ truncated: false, hidden: 0 });
    expect(failureLogListCoverage(1110, 500)).toEqual({ truncated: true, hidden: 610 });
  });
});
