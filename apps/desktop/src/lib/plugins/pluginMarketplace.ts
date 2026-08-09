import type { InstalledPlugin, PluginMarketplaceArtifact, PluginMarketplacePlugin, PluginRepository, PluginRepositoryCatalogResult } from "@/types/database";

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

function listingRepositoryCanVerify(repository: PluginRepository): boolean {
  return repository.kind === "official" || repository.kind === "enterprise";
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
