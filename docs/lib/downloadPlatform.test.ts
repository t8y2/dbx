import assert from "node:assert/strict";
import { test } from "vitest";

import { createInstallOptions } from "./downloadLinks";
import { detectDownloadPlatform, type DownloadNavigator } from "./downloadPlatform";

function macNavigator(architecture?: string): DownloadNavigator {
  return {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    userAgentData: {
      platform: "macOS",
      getHighEntropyValues: async () => ({ architecture }),
    },
  };
}

test("detects Intel macOS from user-agent client hints", async () => {
  const platformId = await detectDownloadPlatform(macNavigator("x86"));
  const download = createInstallOptions("cn", "0.5.85").find((option) => option.id === platformId);

  assert.equal(platformId, "macos-intel");
  assert.match(download?.href ?? "", /_x64\.dmg/);
});

test("detects Apple Silicon macOS from user-agent client hints", async () => {
  assert.equal(await detectDownloadPlatform(macNavigator("arm")), "macos-arm");
});

test("keeps server-side rendering platform-neutral", async () => {
  assert.equal(await detectDownloadPlatform(), "unknown");
});

test("does not treat the legacy Intel Mac user-agent token as CPU architecture", async () => {
  assert.equal(
    await detectDownloadPlatform({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    }),
    "macos-unknown",
  );
});

test("keeps the macOS download neutral when architecture hints return no value", async () => {
  assert.equal(await detectDownloadPlatform(macNavigator()), "macos-unknown");
});

test("keeps the macOS download neutral when architecture hints fail", async () => {
  const browserNavigator = macNavigator();
  browserNavigator.userAgentData!.getHighEntropyValues = async () => {
    throw new Error("blocked");
  };

  assert.equal(await detectDownloadPlatform(browserNavigator), "macos-unknown");
});

test("keeps Windows and Linux platform detection", async () => {
  assert.equal(await detectDownloadPlatform({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }), "windows");
  assert.equal(await detectDownloadPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), "linux");
  assert.equal(await detectDownloadPlatform({ userAgent: "Mozilla/5.0 (X11; Linux aarch64)" }), "linux-arm");
});
