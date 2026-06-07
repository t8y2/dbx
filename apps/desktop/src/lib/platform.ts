export type Platform = "macos" | "windows" | "linux" | "unknown";

export function getPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux")) return "linux";
  return "unknown";
}

export function isMacOS(): boolean {
  return getPlatform() === "macos";
}
