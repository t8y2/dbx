import type { InstalledPlugin, PluginMarketplaceArtifact, PluginMarketplacePlugin, PluginMarketplaceVersion, PluginRepository, PluginRepositoryCatalogResult } from "@/types/database";
import { uuid } from "@/lib/common/utils";

export type MarketplacePluginStatus = "install" | "installed" | "update" | "unsupported";

export type MarketplacePluginSortMode = "name" | "recently-updated" | "recently-listed" | "updates-first";

export const UNIVERSAL_PLUGIN_TARGET = "universal";

export interface MarketplacePluginListing {
  key: string;
  repository: PluginRepository;
  repositoryHomepage?: string;
  plugin: PluginMarketplacePlugin;
  name: string;
  description: string;
  target: string;
  artifact?: PluginMarketplaceArtifact;
  installed?: InstalledPlugin;
  verified: boolean;
  status: MarketplacePluginStatus;
  // releasedAt of the catalog's latestVersion entry, when provided; shown on the card
  // next to the version badge so time-based sort modes have a visible key.
  latestVersionReleasedAt?: string;
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

/**
 * Resolves the external release URL for a specific plugin version.
 *
 * Plugin catalogs often provide repository URLs pointing to a specific branch,
 * tag, or subfolder (e.g. `https://github.com/owner/repo/tree/v0.3.3` or
 * `https://github.com/owner/repo/tree/main/packages/plugin`), or git clone URLs
 * (`.git`). This extracts the base repository root and appends the appropriate
 * release path for the given version tag.
 */
export function resolveMarketplaceReleaseUrl(source?: string | null, version?: string | PluginMarketplaceVersion | null): string {
  const trimmedSource = source?.trim();
  const rawVersion = typeof version === "string" ? version.trim() : (version?.version?.trim() ?? "");
  if (!trimmedSource || !rawVersion) return "";

  const tag = rawVersion.startsWith("v") || rawVersion.startsWith("V") ? rawVersion : `v${rawVersion}`;
  const repo = extractRepositoryBaseUrl(trimmedSource);
  if (!repo) return "";

  if (repo.host === "cnb.cool" || repo.host.endsWith(".cnb.cool")) {
    return `${repo.baseUrl}/-/releases/tag/${encodeURIComponent(tag)}`;
  }
  if (repo.host === "gitlab.com" || repo.host.endsWith(".gitlab.com")) {
    return `${repo.baseUrl}/-/releases/${encodeURIComponent(tag)}`;
  }
  return `${repo.baseUrl}/releases/tag/${encodeURIComponent(tag)}`;
}

export function extractRepositoryBaseUrl(source: string): { baseUrl: string; host: string } | null {
  const trimmed = source.trim();
  if (!trimmed) return null;

  // Handle SSH URLs: git@github.com:owner/repo.git or ssh://git@github.com/owner/repo.git
  const sshMatch = /^(?:ssh:\/\/)?git@([^/:]+)[:/](.+)$/i.exec(trimmed);
  let normalized = trimmed;
  if (sshMatch) {
    const host = sshMatch[1];
    const path = sshMatch[2].replace(/\.git$/i, "").replace(/^\/+/, "");
    normalized = `https://${host}/${path}`;
  } else if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    const cleaned = trimmed
      .replace(/\/(?:-?\/)?(?:tree|blob|releases|src)(?:\/.*)?$/i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
    return cleaned ? { baseUrl: cleaned, host: "" } : null;
  }

  const host = parsed.hostname.toLowerCase();
  const origin = parsed.origin;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  // On GitHub and Gitee, repositories are strictly <owner>/<repo>.
  // Any trailing segment (e.g. /tree/<ref>, /blob/<ref>, /releases) is not part of the repository.
  if (host === "github.com" || host.endsWith(".github.com") || host === "gitee.com" || host.endsWith(".gitee.com")) {
    if (segments.length >= 2) {
      const owner = segments[0];
      const repoName = segments[1].replace(/\.git$/i, "");
      return { baseUrl: `${origin}/${owner}/${repoName}`, host };
    }
    return { baseUrl: `${origin}/${segments[0].replace(/\.git$/i, "")}`, host };
  }

  // On GitLab, CNB, etc., UI routes (tree, blob, releases, etc.) follow a "/-/" segment:
  // e.g. https://gitlab.com/group/subgroup/project/-/tree/main
  // e.g. https://cnb.cool/org/project/-/releases/tag/v1.0.0
  const dashIndex = segments.indexOf("-");
  if (dashIndex > 0) {
    const repoSegments = segments.slice(0, dashIndex);
    repoSegments[repoSegments.length - 1] = repoSegments[repoSegments.length - 1].replace(/\.git$/i, "");
    return { baseUrl: `${origin}/${repoSegments.join("/")}`, host };
  }

  // Generic git hosts (Gitea, Bitbucket, self-hosted, etc.):
  // Strip trailing branches/trees/blobs/releases/src if present
  const cutIndex = segments.findIndex((seg) => ["tree", "blob", "releases", "src"].includes(seg.toLowerCase()));
  if (cutIndex > 0) {
    const repoSegments = segments.slice(0, cutIndex);
    repoSegments[repoSegments.length - 1] = repoSegments[repoSegments.length - 1].replace(/\.git$/i, "");
    return { baseUrl: `${origin}/${repoSegments.join("/")}`, host };
  }

  // Default: strip .git from the last segment
  segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, "");
  return { baseUrl: `${origin}/${segments.join("/")}`, host };
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
          repositoryHomepage: result.catalog?.repository.homepage?.trim() || undefined,
          plugin,
          name: localized.name,
          description: localized.description,
          target: result.target,
          artifact,
          installed,
          verified: plugin.verified && listingRepositoryCanVerify(result.repository),
          status,
          latestVersionReleasedAt: latestVersion?.releasedAt || undefined,
        };
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function selectMarketplaceArtifact(artifacts: readonly PluginMarketplaceArtifact[], target: string): PluginMarketplaceArtifact | undefined {
  return artifacts.find((candidate) => candidate.target === target) || artifacts.find((candidate) => candidate.target === UNIVERSAL_PLUGIN_TARGET);
}

export interface InstalledPluginUpdateEntry {
  listing: MarketplacePluginListing;
  repositoryName: string;
}

// Same plugin id can be published by several enabled repositories. Prefer a repository allowed to
// verify the plugin (official/enterprise), then the higher latestVersion, so every consumer of the
// catalog join (marketplace cards, installed tab, batch) resolves the same single source.
function preferredUpdateListing(left: MarketplacePluginListing, right: MarketplacePluginListing): MarketplacePluginListing {
  if (left.verified !== right.verified) return left.verified ? left : right;
  return compareVersions(right.plugin.latestVersion, left.plugin.latestVersion) > 0 ? right : left;
}

/**
 * Catalog join for the installed tab: update-bearing listings indexed by plugin id, with at most
 * one entry per id (see preferredUpdateListing for the multi-repository collision rule).
 */
export function buildInstalledUpdateIndex(listings: readonly MarketplacePluginListing[]): Map<string, InstalledPluginUpdateEntry> {
  const index = new Map<string, InstalledPluginUpdateEntry>();
  for (const listing of listings) {
    if (listing.status !== "update") continue;
    const existing = index.get(listing.plugin.id);
    if (existing && preferredUpdateListing(existing.listing, listing) === existing.listing) continue;
    index.set(listing.plugin.id, { listing, repositoryName: listing.repository.name });
  }
  return index;
}

export interface PluginSourceChange {
  repositoryChanged: boolean;
  publisherChanged: boolean;
  signingKeyChanged: boolean;
}

/**
 * Compare the provenance recorded at install time against the candidate listing. Null means "no
 * confirmation needed": nothing recorded yet (installs from before provenance existed stay
 * unconstrained), or the recorded repository/publisher/signing key all match the candidate.
 */
export function pluginSourceChange(listing: MarketplacePluginListing): PluginSourceChange | null {
  const provenance = listing.installed?.provenance;
  if (!provenance) return null;
  const repositoryChanged = !!provenance.repositoryId && provenance.repositoryId !== listing.repository.id;
  const publisherChanged = !!provenance.publisher && !!listing.plugin.publisher && provenance.publisher !== listing.plugin.publisher;
  const signingKeyChanged = !!provenance.signingKeyId && !!listing.artifact?.signingKeyId && provenance.signingKeyId !== listing.artifact.signingKeyId;
  if (!repositoryChanged && !publisherChanged && !signingKeyChanged) return null;
  return { repositoryChanged, publisherChanged, signingKeyChanged };
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

// Missing or unparsable releasedAt sorts below every dated listing (-Infinity tail).
function releaseTime(releasedAt: string | undefined): number {
  const time = Date.parse(releasedAt || "");
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

// "Recently updated" must use the SAME value the card renders (latestVersionReleasedAt, the
// catalog's latestVersion entry): the ranking can then never contradict the date on the badge.
// Third-party catalogs are not required to keep latestVersion at the newest date, so a catalog
// that dates an older version later than its current one sorts by the date it advertises for its
// current version — the honest reading of "recently updated". The official store satisfies the
// latestVersion-is-newest invariant 30/30 (verified live 2026-09-24), so real data is unaffected.
function latestVersionReleaseTime(listing: MarketplacePluginListing): number {
  return releaseTime(listing.latestVersionReleasedAt);
}

// "Recently listed" scans EVERY version: nothing on the card claims to display a first-listed
// date, so min(releasedAt) across the catalog is the only signal available (min ≈ first listed,
// the docs-site heuristic) and cannot contradict the badge.
function firstReleaseTime(listing: MarketplacePluginListing): number {
  const times = listing.plugin.versions.map((version) => Date.parse(version.releasedAt || "")).filter((time) => !Number.isNaN(time));
  return times.length ? Math.min(...times) : Number.NEGATIVE_INFINITY;
}

// Copies before sorting: the builder output is also consumed elsewhere (batch selection,
// the installed-tab update index) and must keep its name order there.
export function sortMarketplacePluginListings(listings: readonly MarketplacePluginListing[], mode: MarketplacePluginSortMode): MarketplacePluginListing[] {
  const byName = (left: MarketplacePluginListing, right: MarketplacePluginListing) => left.name.localeCompare(right.name);
  if (mode === "name") return [...listings].sort(byName);
  const releaseTimeFor = mode === "recently-listed" ? firstReleaseTime : latestVersionReleaseTime;
  if (mode === "updates-first") {
    return [...listings].sort((left, right) => {
      const updatable = (listing: MarketplacePluginListing) => (listing.status === "update" ? 0 : 1);
      if (updatable(left) !== updatable(right)) return updatable(left) - updatable(right);
      return releaseTimeFor(right) - releaseTimeFor(left) || byName(left, right);
    });
  }
  return [...listings].sort((left, right) => releaseTimeFor(right) - releaseTimeFor(left) || byName(left, right));
}

export function formatMarketplaceReleasedDate(releasedAt: string | undefined, locale: string): string {
  if (!releasedAt) return "";
  const date = new Date(releasedAt);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale.replace("_", "-"), { dateStyle: "medium" }).format(date);
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

// Semver prerelease ordering: an identifier pair compares numerically when both are numeric,
// numeric ranks below alphanumeric, a shorter identifier list ranks lower, and a version WITHOUT
// a prerelease ranks above any prerelease. Plain localeCompare gets the last rule backwards
// ("~" collates below letters), which used to rank releases below their own betas.
function comparePrerelease(left: string, right: string): number {
  if (left === right) return 0;
  if (left === "~") return 1;
  if (right === "~") return -1;
  const leftIds = left.split(".");
  const rightIds = right.split(".");
  for (let index = 0; index < Math.max(leftIds.length, rightIds.length); index += 1) {
    const leftId = leftIds[index];
    const rightId = rightIds[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    const leftNumber = Number(leftId);
    const rightNumber = Number(rightId);
    const leftNumeric = leftId !== "" && !Number.isNaN(leftNumber);
    const rightNumeric = rightId !== "" && !Number.isNaN(rightNumber);
    if (leftNumeric && rightNumeric) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftId !== rightId) {
      return leftId < rightId ? -1 : 1;
    }
  }
  return 0;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  const leftNumbers = leftParts.slice(0, 3) as [number, number, number];
  const rightNumbers = rightParts.slice(0, 3) as [number, number, number];
  for (let index = 0; index < leftNumbers.length; index += 1) {
    if (leftNumbers[index] !== rightNumbers[index]) return leftNumbers[index] - rightNumbers[index];
  }
  return comparePrerelease(leftParts[3], rightParts[3]);
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
