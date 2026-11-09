import { describe, expect, it } from "vitest";
import { shouldAutoConnectAfterCreate, shouldAutoSubmitConnectionDeepLink, type AutoConnectAfterCreateContext } from "@/lib/connection/connectionAutoConnect";
import type { AutoConnectAfterCreateMode } from "@/stores/settingsStore";

const deepLink: AutoConnectAfterCreateContext = { isNew: true, fromDeepLink: true };
const manual: AutoConnectAfterCreateContext = { isNew: true, fromDeepLink: false };
const edited: AutoConnectAfterCreateContext = { isNew: false, fromDeepLink: true };

describe("shouldAutoConnectAfterCreate", () => {
  it("never connects automatically when the setting is off", () => {
    for (const context of [deepLink, manual, edited]) {
      expect(shouldAutoConnectAfterCreate("off", context)).toBe(false);
    }
  });

  it("only connects deep-link creations in deepLink mode", () => {
    expect(shouldAutoConnectAfterCreate("deepLink", deepLink)).toBe(true);
    expect(shouldAutoConnectAfterCreate("deepLink", manual)).toBe(false);
    expect(shouldAutoConnectAfterCreate("deepLink", edited)).toBe(false);
  });

  it("connects every new connection in all mode, but never an edited one", () => {
    expect(shouldAutoConnectAfterCreate("all", deepLink)).toBe(true);
    expect(shouldAutoConnectAfterCreate("all", manual)).toBe(true);
    expect(shouldAutoConnectAfterCreate("all", edited)).toBe(false);
  });

  it("keeps the historical save-and-connect behavior when the setting is missing", () => {
    expect(shouldAutoConnectAfterCreate(undefined, deepLink)).toBe(true);
    expect(shouldAutoConnectAfterCreate(undefined, manual)).toBe(true);
    expect(shouldAutoConnectAfterCreate(undefined, edited)).toBe(false);
    expect(shouldAutoConnectAfterCreate("sometimes" as AutoConnectAfterCreateMode, manual)).toBe(true);
  });
});

describe("shouldAutoSubmitConnectionDeepLink", () => {
  it("skips the confirmation dialog whenever auto-connect covers deep links", () => {
    expect(shouldAutoSubmitConnectionDeepLink("deepLink")).toBe(true);
    expect(shouldAutoSubmitConnectionDeepLink("all")).toBe(true);
  });

  it("keeps the existing confirmation setting when auto-connect is off", () => {
    expect(shouldAutoSubmitConnectionDeepLink("off")).toBe(false);
    expect(shouldAutoSubmitConnectionDeepLink(undefined)).toBe(false);
  });
});
