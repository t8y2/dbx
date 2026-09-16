export type DownloadPlatformId = "unknown" | "linux-arm" | "linux" | "macos-unknown" | "macos-arm" | "macos-intel" | "windows";

type UserAgentDataLike = {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
};

export type NavigatorLike = {
  userAgent: string;
  userAgentData?: UserAgentDataLike;
};

async function detectArchitecture(navigatorLike: NavigatorLike): Promise<string> {
  try {
    const values = await navigatorLike.userAgentData?.getHighEntropyValues?.(["architecture"]);
    return values?.architecture?.toLowerCase() ?? "";
  } catch {
    return "";
  }
}

export async function detectPlatformId(navigatorLike?: NavigatorLike): Promise<DownloadPlatformId> {
  if (!navigatorLike) return "unknown";

  const userAgent = navigatorLike.userAgent.toLowerCase();
  const platform = navigatorLike.userAgentData?.platform?.toLowerCase() ?? "";
  if (userAgent.includes("win") || platform === "windows") return "windows";

  const architecture = await detectArchitecture(navigatorLike);
  const isArm = architecture.includes("arm") || userAgent.includes("aarch64") || userAgent.includes("arm");

  if (userAgent.includes("linux") || platform === "linux") return isArm ? "linux-arm" : "linux";
  if (userAgent.includes("macintosh") || platform === "macos") {
    if (architecture.includes("x86") || architecture.includes("amd64") || architecture.includes("x64")) return "macos-intel";
    if (architecture.includes("arm") || architecture.includes("aarch64")) return "macos-arm";
    return "macos-unknown";
  }
  return "unknown";
}
