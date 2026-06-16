import { describe, expect, it } from "vitest";
import { MQ_PINNED_VERSION_AUTO, MQ_PINNED_VERSION_OPTIONS, pinnedVersionToSelection, selectionToPinnedVersion } from "@/lib/mqPinnedVersionOptions";

describe("mqPinnedVersionOptions", () => {
  it("offers auto-detection and the supported Pulsar 3.x profile", () => {
    expect(MQ_PINNED_VERSION_OPTIONS.map((option) => option.value)).toEqual([MQ_PINNED_VERSION_AUTO, "3.1.x"]);
  });

  it("normalizes existing Pulsar 3.x pinned values to the supported profile option", () => {
    expect(pinnedVersionToSelection(undefined)).toBe(MQ_PINNED_VERSION_AUTO);
    expect(pinnedVersionToSelection("")).toBe(MQ_PINNED_VERSION_AUTO);
    expect(pinnedVersionToSelection("3.0.7")).toBe("3.1.x");
    expect(pinnedVersionToSelection("3.1.2")).toBe("3.1.x");
    expect(pinnedVersionToSelection("3.1.x")).toBe("3.1.x");
  });

  it("only persists an explicit version when a supported profile is selected", () => {
    expect(selectionToPinnedVersion(MQ_PINNED_VERSION_AUTO)).toBeUndefined();
    expect(selectionToPinnedVersion("3.1.x")).toBe("3.1.x");
    expect(selectionToPinnedVersion("4.0.x")).toBeUndefined();
  });
});
