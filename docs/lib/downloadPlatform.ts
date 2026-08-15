export type DownloadPlatformId = "unknown" | "macos-unknown" | "macos-arm" | "macos-intel" | "windows" | "linux" | "linux-arm";

type UserAgentData = {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
};

export type DownloadNavigator = {
  userAgent: string;
  userAgentData?: UserAgentData;
};

function architecturePlatformId(architecture: string | undefined): DownloadPlatformId | undefined {
  const normalized = architecture?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "x86" || normalized === "x86_64" || normalized === "amd64") return "macos-intel";
  if (normalized === "arm" || normalized === "arm64" || normalized === "aarch64") return "macos-arm";
  return undefined;
}

export async function detectDownloadPlatform(browserNavigator?: DownloadNavigator): Promise<DownloadPlatformId> {
  if (!browserNavigator) return "unknown";

  const ua = browserNavigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux")) return ua.includes("aarch64") || ua.includes("arm") ? "linux-arm" : "linux";

  const clientPlatform = browserNavigator.userAgentData?.platform?.toLowerCase();
  const isMac = ua.includes("mac") || clientPlatform === "macos";
  if (!isMac) return "unknown";

  const getHighEntropyValues = browserNavigator.userAgentData?.getHighEntropyValues;
  if (getHighEntropyValues) {
    try {
      const { architecture } = await getHighEntropyValues.call(browserNavigator.userAgentData, ["architecture"]);
      const detected = architecturePlatformId(architecture);
      if (detected) return detected;
    } catch {
      // Architecture hints are optional and may be blocked by the browser.
    }
  }

  // Legacy macOS user-agent strings are not architecture-safe: Apple Silicon
  // browsers may still contain "Intel Mac OS X" for compatibility.
  return "macos-unknown";
}
