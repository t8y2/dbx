export type InstallLang = "en" | "cn";
export type BrowserStaticArch = "x64" | "arm64";

export type BrowserStaticDownload = {
  arch: BrowserStaticArch;
  href: string;
};

export type InstallOption = {
  id: string;
  iconId: string;
  label: string;
  description?: string;
  driverLinkLabel?: string;
  descriptionSuffix?: string;
  badge?: string;
  href: string;
  action?: "download" | "instructions";
  browserStaticDownloads?: BrowserStaticDownload[];
};

type DownloadArtifact = {
  id: string;
  iconId: string;
  labels: Record<InstallLang, string>;
  descriptions?: Record<InstallLang, string>;
  driverLinkLabels?: Record<InstallLang, string>;
  descriptionSuffixes?: Record<InstallLang, string>;
  badges?: Record<InstallLang, string>;
  suffix: string;
  action?: "download" | "instructions";
  browserStaticSuffixes?: Record<BrowserStaticArch, string>;
};

const DOWNLOAD_BASE_URL = "https://dl.dbxio.com/releases";

const downloadArtifacts: DownloadArtifact[] = [
  {
    id: "macos-arm",
    iconId: "macos-arm",
    labels: { en: "For macOS (Apple Silicon)", cn: "适用于 macOS (Apple Silicon)" },
    suffix: "arm64.dmg",
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
    labels: { en: "Windows 10 intranet environment installer", cn: "Windows10内网环境安装包" },
    descriptions: { en: "Includes WebView2 offline runtime · Does not include", cn: "内置 WebView2 离线运行库 · 不含" },
    driverLinkLabels: { en: "offline database drivers", cn: "数据库离线驱动" },
    badges: { en: "Intranet", cn: "内网" },
    suffix: "x64-offline-setup.exe",
  },
  {
    id: "windows-7-offline",
    iconId: "windows-legacy",
    labels: { en: "Windows 7 / Server\u00a02012\u00a0R2 package", cn: "Windows 7 / Server\u00a02012\u00a0R2 专用包" },
    descriptions: { en: "Includes WebView2 offline runtime · Does not include", cn: "内置 WebView2 离线运行库 · 不含" },
    driverLinkLabels: { en: "offline database drivers", cn: "数据库离线驱动" },
    badges: { en: "Legacy", cn: "旧系统" },
    suffix: "x64-win7-server2012r2-offline-setup.exe",
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
    suffix: "arm64.AppImage",
  },
  {
    id: "linux-browser",
    iconId: "linux",
    labels: { en: "Linux browser package", cn: "Linux 浏览器版" },
    descriptions: { en: "For Kylin, UnionTech UOS, and other Linux distributions", cn: "适用于麒麟、统信 UOS 等 Linux 发行版" },
    badges: { en: "Guide", cn: "安装说明" },
    suffix: "x64-browser-static.tar.gz",
    action: "instructions",
    browserStaticSuffixes: {
      x64: "x64-browser-static.tar.gz",
      arm64: "arm64-browser-static.tar.gz",
    },
  },
];

export function createInstallOptions(lang: InstallLang, version: string): InstallOption[] {
  return downloadArtifacts.map((artifact) => ({
    id: artifact.id,
    iconId: artifact.iconId,
    label: artifact.labels[lang],
    description: artifact.descriptions?.[lang],
    driverLinkLabel: artifact.driverLinkLabels?.[lang],
    descriptionSuffix: artifact.descriptionSuffixes?.[lang],
    badge: artifact.badges?.[lang],
    href: `${DOWNLOAD_BASE_URL}/v${version}/DBX_${version}_${artifact.suffix}?v=${version}`,
    action: artifact.action ?? "download",
    browserStaticDownloads: artifact.browserStaticSuffixes
      ? Object.entries(artifact.browserStaticSuffixes).map(([arch, suffix]) => ({
          arch: arch as BrowserStaticArch,
          href: `${DOWNLOAD_BASE_URL}/v${version}/DBX_${version}_${suffix}?v=${version}`,
        }))
      : undefined,
  }));
}
