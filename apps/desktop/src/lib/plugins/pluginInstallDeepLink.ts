const PLUGIN_INSTALL_DEEP_LINK_HOST = "plugins";
const PLUGIN_INSTALL_DEEP_LINK_PATH = "/install";
const MAX_DEEP_LINK_LENGTH = 4096;
const MAX_PACKAGE_URL_LENGTH = 2048;

export interface PluginInstallDeepLinkDraft {
  url: string;
}

/**
 * Parses `dbx://plugins/install?url=<encoded package url>` links.
 * Returns null for non-matching links and throws for malformed ones,
 * mirroring the AI config deep-link parser contract.
 */
export function parsePluginInstallDeepLink(value: string): PluginInstallDeepLinkDraft | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_DEEP_LINK_LENGTH) return null;
  if (!trimmed.startsWith("dbx://")) return null;

  const url = new URL(trimmed);
  if (url.host !== PLUGIN_INSTALL_DEEP_LINK_HOST || url.pathname !== PLUGIN_INSTALL_DEEP_LINK_PATH) return null;

  const packageUrl = url.searchParams.get("url")?.trim() ?? "";
  if (!packageUrl) throw new Error("Missing url");
  if (packageUrl.length > MAX_PACKAGE_URL_LENGTH) throw new Error("Package url is too long");

  const protocol = new URL(packageUrl).protocol;
  if (protocol !== "http:" && protocol !== "https:") throw new Error("Package url must be http(s)");

  return { url: packageUrl };
}
