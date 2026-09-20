import type { InstalledPlugin, PluginMarketplaceArtifact, PluginMarketplacePlugin, PluginRepository, PluginRepositoryCatalogResult } from "@/types/database";
import { uuid } from "@/lib/common/utils";

export type MarketplacePluginStatus = "install" | "installed" | "update" | "unsupported";

export const UNIVERSAL_PLUGIN_TARGET = "universal";

export interface MarketplacePluginListing {
  key: string;
  repository: PluginRepository;
  plugin: PluginMarketplacePlugin;
  name: string;
  description: string;
  target: string;
  artifact?: PluginMarketplaceArtifact;
  installed?: InstalledPlugin;
  verified: boolean;
  status: MarketplacePluginStatus;
}

/**
 * Returns the homepage only when it points somewhere different from the
 * source repository. Marketplace metadata often repeats the repository URL in
 * both fields, which otherwise renders two identical links.
 */
export function marketplaceHomepageUrl(source?: string, homepage?: string): string | undefined {
  const normalizedSource = normalizeExternalUrl(source);
  const normalizedHomepage = normalizeExternalUrl(homepage);
  if (!normalizedHomepage || normalizedHomepage === normalizedSource) return undefined;
  return homepage?.trim() || undefined;
}

export function buildMarketplacePluginListings(results: readonly PluginRepositoryCatalogResult[], installedPlugins: readonly InstalledPlugin[], locale: string): MarketplacePluginListing[] {
  const installedById = new Map(installedPlugins.map((plugin) => [plugin.manifest.id, plugin]));
  return results
    .flatMap((result) =>
      (result.catalog?.plugins || []).map((plugin) => {
        const localized = marketplacePluginLocalization(plugin, locale);
        const latestVersion = plugin.versions.find((version) => version.version === plugin.latestVersion);
        const artifact = latestVersion ? selectMarketplaceArtifact(latestVersion.artifacts, result.target) : undefined;
        const installed = installedById.get(plugin.id);
        const status: MarketplacePluginStatus = !artifact ? "unsupported" : !installed ? "install" : compareVersions(plugin.latestVersion, installed.manifest.version || "0.0.0") > 0 ? "update" : "installed";
        return {
          key: `${result.repository.id}:${plugin.id}`,
          repository: result.repository,
          plugin,
          name: localized.name,
          description: localized.description,
          target: result.target,
          artifact,
          installed,
          verified: plugin.verified && listingRepositoryCanVerify(result.repository),
          status,
        };
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function selectMarketplaceArtifact(artifacts: readonly PluginMarketplaceArtifact[], target: string): PluginMarketplaceArtifact | undefined {
  return artifacts.find((candidate) => candidate.target === target) || artifacts.find((candidate) => candidate.target === UNIVERSAL_PLUGIN_TARGET);
}

export function listingRepositoryCanVerify(repository: PluginRepository): boolean {
  return repository.kind === "official" || repository.kind === "enterprise";
}

const INSTALL_BEACON_URL = "https://dbxio.com/api/plugins/install";
const INSTALLATION_ID_STORAGE_KEY = "dbx-installation-id";
const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Anonymous, purely random per-installation id so server-side stats can count
// distinct machines without any user or hardware fingerprint. Clearing local
// storage (or reinstalling) regenerates it, which is acceptable for
// decorative statistics.
function installationClientId(): string {
  try {
    if (typeof localStorage === "undefined") return "";
    let id = localStorage.getItem(INSTALLATION_ID_STORAGE_KEY);
    if (!id || !INSTALLATION_ID_PATTERN.test(id)) {
      id = uuid();
      localStorage.setItem(INSTALLATION_ID_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return "";
  }
}

export type PluginInstallBeaconKind = "install" | "update";

// Fire-and-forget install beacon for marketplace statistics; never blocks or
// fails the install. `kind` separates fresh installs from version updates so
// update traffic cannot inflate the install numbers.
export function beaconPluginInstall(pluginId: string, version: string, kind: PluginInstallBeaconKind = "install"): void {
  try {
    void fetch(INSTALL_BEACON_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ id: pluginId, version, kind, clientId: installationClientId() }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Statistics are best-effort.
  }
}

export function filterMarketplacePluginListings(listings: readonly MarketplacePluginListing[], query: string, repositoryId: string): MarketplacePluginListing[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return listings.filter((listing) => {
    if (repositoryId !== "all" && listing.repository.id !== repositoryId) return false;
    if (!normalizedQuery) return true;
    return [listing.plugin.id, listing.name, listing.description, listing.plugin.publisher, listing.repository.name, ...listing.plugin.tags].join("\n").toLocaleLowerCase().includes(normalizedQuery);
  });
}

function marketplacePluginLocalization(plugin: PluginMarketplacePlugin, locale: string): { name: string; description: string } {
  const normalizedLocale = locale.replace("_", "-").toLowerCase();
  const entries = Object.entries(plugin.localizations || {});
  const localization = entries.find(([key]) => key.replace("_", "-").toLowerCase() === normalizedLocale)?.[1] || entries.find(([key]) => key.replace("_", "-").toLowerCase() === normalizedLocale.split("-")[0])?.[1];
  return {
    name: localization?.name?.trim() || plugin.name,
    description: localization?.description?.trim() || plugin.description,
  };
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  const leftNumbers = leftParts.slice(0, 3) as [number, number, number];
  const rightNumbers = rightParts.slice(0, 3) as [number, number, number];
  for (let index = 0; index < leftNumbers.length; index += 1) {
    if (leftNumbers[index] !== rightNumbers[index]) return leftNumbers[index] - rightNumbers[index];
  }
  return leftParts[3].localeCompare(rightParts[3]);
}

function parseVersion(version: string): [number, number, number, string] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || "~"];
}

function normalizeExternalUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`;
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}
