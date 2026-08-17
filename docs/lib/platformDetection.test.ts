import assert from "node:assert/strict";
import { test } from "vitest";

import { createInstallOptions } from "./downloadLinks";
import { detectPlatformId, type NavigatorLike } from "./platformDetection";

const macUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36";

function macNavigator(architecture?: string): NavigatorLike {
  return {
    userAgent: macUserAgent,
    userAgentData: {
      platform: "macOS",
      getHighEntropyValues: async () => ({ architecture }),
    },
  };
}

test("detects an Intel Mac from Chromium architecture hints", async () => {
  const platformId = await detectPlatformId(macNavigator("x86"));
  const download = createInstallOptions("cn", "0.5.85").find((option) => option.id === platformId);

  assert.equal(platformId, "macos-intel");
  assert.match(download?.href ?? "", /_x64\.dmg/);
});

test("does not trust the Intel token in an Apple Silicon Mac user agent", async () => {
  assert.equal(await detectPlatformId(macNavigator("arm")), "macos-arm");
});

test("keeps server-side rendering platform-neutral", async () => {
  assert.equal(await detectPlatformId(), "unknown");
});

test("does not infer CPU architecture from the legacy Intel Mac user-agent token", async () => {
  assert.equal(await detectPlatformId({ userAgent: macUserAgent }), "macos-unknown");
});

test("keeps the macOS download neutral when architecture hints return no value", async () => {
  assert.equal(await detectPlatformId(macNavigator()), "macos-unknown");
});

test("keeps the macOS download neutral when architecture hints fail", async () => {
  const browserNavigator = macNavigator();
  browserNavigator.userAgentData!.getHighEntropyValues = async () => {
    throw new Error("blocked");
  };

  assert.equal(await detectPlatformId(browserNavigator), "macos-unknown");
});

test("keeps existing Windows and Linux detection", async () => {
  assert.equal(await detectPlatformId({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }), "windows");
  assert.equal(await detectPlatformId({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), "linux");
  assert.equal(await detectPlatformId({ userAgent: "Mozilla/5.0 (X11; Linux aarch64)" }), "linux-arm");
});
