import type { DocsLang } from "@/lib/i18n";
import type { DownloadPlatformId } from "@/lib/platformDetection";

export type PluginArtifact = {
  target: string;
  url: string;
  sha256: string;
  signingKeyId: string;
  size: number;
};

export type PluginVersion = {
  version: string;
  releasedAt: string;
  releaseNotes?: string;
  artifacts: PluginArtifact[];
};

export type PluginLocalization = {
  name?: string;
  description?: string;
};

export type MarketplacePlugin = {
  id: string;
  name: string;
  description: string;
  publisher: string;
  verified?: boolean;
  icon?: string;
  tags?: string[];
  permissions?: string[];
  source?: string;
  homepage?: string;
  license?: string;
  latestVersion: string;
  versions: PluginVersion[];
  localizations?: Record<string, PluginLocalization>;
};

export type PluginCatalog = {
  catalogVersion?: number;
  repository?: { id?: string; name?: string; homepage?: string };
  plugins: MarketplacePlugin[];
};

// Same source the in-app plugin center consumes (R2 primary, GitHub raw fallback);
// R2 responds with a dbxio.com CORS header, so the browser refresh path works too.
export const PLUGIN_CATALOG_URLS = [
  "https://dl.dbxio.com/catalog/index.json",
  "https://raw.githubusercontent.com/t8y2/dbx-store/main/catalog/index.json",
] as const;

export const DBX_STORE_URL = "https://github.com/t8y2/dbx-store";
export const DBX_STORE_CONTRIBUTING_URL = "https://github.com/t8y2/dbx-store/blob/main/CONTRIBUTING.md";

function isPluginCatalog(value: unknown): value is PluginCatalog {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as PluginCatalog).plugins) &&
    (value as PluginCatalog).plugins.every((plugin) => typeof plugin?.id === "string")
  );
}

export async function fetchPluginCatalog(init?: RequestInit): Promise<PluginCatalog | null> {
  for (const url of PLUGIN_CATALOG_URLS) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, ...init });
      if (!response.ok) throw new Error(`Plugin catalog request failed with ${response.status}`);
      const catalog = (await response.json()) as unknown;
      if (isPluginCatalog(catalog)) return catalog;
    } catch {
      // Try the synchronized GitHub mirror next.
    }
  }
  return null;
}

export function pluginDisplayName(plugin: MarketplacePlugin, lang: DocsLang): string {
  if (lang === "cn") return plugin.localizations?.["zh-CN"]?.name || plugin.name;
  return plugin.name;
}

export function pluginDisplayDescription(plugin: MarketplacePlugin, lang: DocsLang): string {
  if (lang === "cn") return plugin.localizations?.["zh-CN"]?.description || plugin.description;
  return plugin.description;
}

export function latestPluginVersion(plugin: MarketplacePlugin): PluginVersion | null {
  return plugin.versions.find((version) => version.version === plugin.latestVersion) ?? plugin.versions[0] ?? null;
}

export function formatPluginSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "—";
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

export function formatPluginDate(iso: string, lang: DocsLang): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(lang === "cn" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

// Relative timestamps go stale in prerendered HTML, so callers render the
// absolute date until mount and switch to this after hydration.
export function formatRelativePluginTime(iso: string, lang: DocsLang): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const elapsedMs = Date.now() - date.getTime();
  if (elapsedMs < 60 * 1000) return lang === "cn" ? "刚刚" : "just now";
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["minute", 60 * 1000],
    ["hour", 60 * 60 * 1000],
    ["day", 24 * 60 * 60 * 1000],
    ["month", 30 * 24 * 60 * 60 * 1000],
    ["year", 365 * 24 * 60 * 60 * 1000],
  ];
  let unit: Intl.RelativeTimeFormatUnit = "year";
  let divisor = units[units.length - 1][1];
  for (let i = units.length - 1; i >= 0; i -= 1) {
    if (elapsedMs >= units[i][1]) {
      unit = units[i][0];
      divisor = units[i][1];
      break;
    }
  }
  const value = -Math.floor(elapsedMs / divisor);
  return new Intl.RelativeTimeFormat(lang === "cn" ? "zh-CN" : "en-US", { numeric: "auto" }).format(value, unit);
}

export const PLUGIN_TARGET_LABELS: Record<string, { en: string; cn: string }> = {
  "darwin-arm64": { en: "macOS (Apple Silicon)", cn: "macOS（Apple Silicon）" },
  "darwin-x64": { en: "macOS (Intel)", cn: "macOS（Intel）" },
  "linux-arm64": { en: "Linux (ARM64)", cn: "Linux（ARM64）" },
  "linux-x64": { en: "Linux (x64)", cn: "Linux（x64）" },
  "windows-arm64": { en: "Windows (ARM64)", cn: "Windows（ARM64）" },
  "windows-x64": { en: "Windows (x64)", cn: "Windows（x64）" },
};

export function pluginTargetLabel(target: string, lang: DocsLang): string {
  return PLUGIN_TARGET_LABELS[target]?.[lang] ?? target;
}

const PLATFORM_TARGET: Record<DownloadPlatformId, string> = {
  "macos-arm": "darwin-arm64",
  "macos-intel": "darwin-x64",
  "macos-unknown": "darwin-arm64",
  linux: "linux-x64",
  "linux-arm": "linux-arm64",
  windows: "windows-x64",
  unknown: "darwin-arm64",
};

export function platformArtifactTarget(platformId: DownloadPlatformId): string {
  return PLATFORM_TARGET[platformId] ?? "darwin-arm64";
}

export function preferredArtifactFor(artifacts: PluginArtifact[], platformId: DownloadPlatformId): PluginArtifact | null {
  const target = platformArtifactTarget(platformId);
  return artifacts.find((artifact) => artifact.target === target) ?? artifacts[0] ?? null;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
