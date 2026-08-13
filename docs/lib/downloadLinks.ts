export type InstallLang = "en" | "cn";

export type InstallOption = {
  id: string;
  iconId: string;
  label: string;
  description?: string;
  badge?: string;
  href: string;
};

type DownloadArtifact = {
  id: string;
  iconId: string;
  labels: Record<InstallLang, string>;
  descriptions?: Record<InstallLang, string>;
  badges?: Record<InstallLang, string>;
  suffix: string;
};

const DOWNLOAD_BASE_URL = "https://dl.dbxio.com/releases/latest";

const downloadArtifacts: DownloadArtifact[] = [
  {
    id: "macos-arm",
    iconId: "macos-arm",
    labels: { en: "For macOS (Apple Silicon)", cn: "适用于 macOS (Apple Silicon)" },
    suffix: "aarch64.dmg",
  },
  {
    id: "macos-intel",
    iconId: "macos-intel",
    labels: { en: "For macOS (Intel)", cn: "适用于 macOS (Intel)" },
    suffix: "x64.dmg",
  },
  {
    id: "windows",
    iconId: "windows",
    labels: { en: "Windows 10/11 (x64)", cn: "Windows 10/11 (x64)" },
    descriptions: { en: "Standard online installer", cn: "标准在线安装包" },
    badges: { en: "Recommended", cn: "推荐" },
    suffix: "x64-setup.exe",
  },
  {
    id: "windows-offline",
    iconId: "windows",
    labels: { en: "Windows complete offline installer", cn: "Windows 完整离线安装包" },
    descriptions: { en: "Includes WebView2 · For offline deployment or missing runtime", cn: "内置 WebView2 · 适用于内网部署或运行库缺失" },
    badges: { en: "Offline", cn: "离线" },
    suffix: "x64-webview2-offline-setup.exe",
  },
  {
    id: "windows-7-offline",
    iconId: "windows",
    labels: { en: "Windows 7 offline installer", cn: "Windows 7 离线安装包" },
    descriptions: { en: "Includes WebView2 109 · x64 only", cn: "内置 WebView2 109 · 仅支持 x64" },
    badges: { en: "Legacy", cn: "旧系统" },
    suffix: "x64-win7-webview2-109-offline-setup.exe",
  },
  {
    id: "linux",
    iconId: "linux",
    labels: { en: "For Linux x64", cn: "适用于 Linux x64" },
    suffix: "amd64.AppImage",
  },
  {
    id: "linux-arm",
    iconId: "linux-arm",
    labels: { en: "For Linux ARM64", cn: "适用于 Linux ARM64" },
    suffix: "aarch64.AppImage",
  },
];

export function createInstallOptions(lang: InstallLang, version: string): InstallOption[] {
  return downloadArtifacts.map((artifact) => ({
    id: artifact.id,
    iconId: artifact.iconId,
    label: artifact.labels[lang],
    description: artifact.descriptions?.[lang],
    badge: artifact.badges?.[lang],
    href: `${DOWNLOAD_BASE_URL}/DBX_${version}_${artifact.suffix}?v=${version}`,
  }));
}
