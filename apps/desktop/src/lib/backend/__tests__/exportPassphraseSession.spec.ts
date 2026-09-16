// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { clearRememberedExportPassphrase, getRememberedExportPassphrase, rememberExportPassphrase } from "@/lib/backend/exportPassphraseSession";

describe("exportPassphraseSession", () => {
  beforeEach(() => {
    clearRememberedExportPassphrase();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("starts with no remembered passphrase", () => {
    expect(getRememberedExportPassphrase()).toBe("");
  });

  it("remembers the passphrase within the current session", () => {
    rememberExportPassphrase("session-passphrase");
    expect(getRememberedExportPassphrase()).toBe("session-passphrase");

    rememberExportPassphrase("second-passphrase");
    expect(getRememberedExportPassphrase()).toBe("second-passphrase");
  });

  it("never persists the passphrase to localStorage or sessionStorage", () => {
    rememberExportPassphrase("session-passphrase");

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
