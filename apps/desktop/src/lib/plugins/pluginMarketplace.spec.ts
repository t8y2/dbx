import { describe, expect, it } from "vitest";
import {
  buildInstalledUpdateIndex,
  buildMarketplacePluginListings,
  compareVersions,
  filterMarketplacePluginListings,
  formatMarketplaceReleasedDate,
  marketplaceHomepageUrl,
  pluginSourceChange,
  selectMarketplaceArtifact,
  sortMarketplacePluginListings,
  type MarketplacePluginListing,
} from "./pluginMarketplace";
import type { InstalledPlugin, PluginMarketplacePlugin, PluginRepositoryCatalogResult } from "@/types/database";

const result: PluginRepositoryCatalogResult = {
  repository: { id: "dbx-official", name: "DBX Marketplace", kind: "official", enabled: true, managed: true },
  target: "darwin-arm64",
  catalog: {
    catalogVersion: 1,
    repository: { id: "dbx-official", name: "DBX Marketplace" },
    plugins: [
      {
        id: "example.hello",
        name: "Hello",
        description: "Greets the user",
        publisher: "DBX",
        verified: true,
        tags: ["sample"],
        permissions: [],
        latestVersion: "1.1.0",
        versions: [
          {
            version: "1.1.0",
            artifacts: [{ target: "darwin-arm64", url: "https://plugins.example.com/hello.dbxp", sha256: "a".repeat(64), signingKeyId: "dbx.release" }],
          },
        ],
        localizations: { "zh-CN": { name: "你好工作台", description: "用于验证插件工作台" } },
      },
    ],
  },
};

function installed(version: string): InstalledPlugin {
  return {
    manifest: {
      manifest_version: 1,
      id: "example.hello",
      name: "Hello",
      version,
      publisher: "DBX",
      description: "",
      engines: { dbx: "", host_api: "" },
      permissions: [],
      entrypoints: {},
      contributions: [],
      drivers: [],
      protocol_version: 1,
    },
    compatibility: { compatible: true, errors: [], warnings: [], target: "darwin-arm64" },
  };
}

function installedFor(pluginId: string, version: string): InstalledPlugin {
  const plugin = installed(version);
  plugin.manifest.id = pluginId;
  return plugin;
}

function repositoryResult(repositoryId: string, repositoryName: string, latestVersion: string, verified = true): PluginRepositoryCatalogResult {
  const copy = structuredClone(result);
  copy.repository = { id: repositoryId, name: repositoryName, kind: verified ? "official" : "custom", enabled: true, managed: !verified ? false : true };
  copy.catalog!.repository = { id: repositoryId, name: repositoryName };
  copy.catalog!.plugins[0].verified = verified;
  // Catalog validation requires latestVersion to exist in versions, so keep both in sync.
  copy.catalog!.plugins[0].latestVersion = latestVersion;
  copy.catalog!.plugins[0].versions[0].version = latestVersion;
  return copy;
}

describe("plugin marketplace listings", () => {
  it("localizes, detects updates, and filters by repository", () => {
    const listings = buildMarketplacePluginListings([result], [installed("1.0.0")], "zh-CN");

    expect(listings[0]).toMatchObject({ name: "你好工作台", status: "update", target: "darwin-arm64" });
    expect(filterMarketplacePluginListings(listings, "验证", "dbx-official")).toHaveLength(1);
  });

  it("marks a plugin unsupported when the current target has no artifact", () => {
    const unsupported = structuredClone(result);
    unsupported.target = "linux-x64";

    expect(buildMarketplacePluginListings([unsupported], [], "en")[0].status).toBe("unsupported");
  });

  it("keeps a newer installed version installed instead of offering a downgrade", () => {
    const listings = buildMarketplacePluginListings([result], [installed("1.2.0")], "en");

    // The catalog lags behind the installed build: the card must stay on the installed state.
    expect(listings[0]).toMatchObject({ status: "installed", installed: { manifest: { version: "1.2.0" } } });
    // Only "update" swaps the card's bottom-left line to the two-version text, so this state renders the
    // plain installed line for 1.2.0 rather than the catalog's older 1.1.0.
    expect(listings[0].plugin.latestVersion).toBe("1.1.0");
  });

  it("uses a universal artifact when the current target has no exact artifact", () => {
    const universal = structuredClone(result);
    universal.target = "linux-x64";
    universal.catalog!.plugins[0].versions[0].artifacts = [{ target: "universal", url: "https://plugins.example.com/hello-universal.dbxp", sha256: "b".repeat(64), signingKeyId: "dbx.release" }];

    expect(buildMarketplacePluginListings([universal], [], "en")[0]).toMatchObject({ status: "install", artifact: { target: "universal" } });
  });

  it("prefers an exact artifact over the universal fallback", () => {
    const artifacts = [
      { target: "universal", url: "https://plugins.example.com/hello-universal.dbxp", sha256: "a".repeat(64), signingKeyId: "dbx.release" },
      { target: "darwin-arm64", url: "https://plugins.example.com/hello-darwin.dbxp", sha256: "b".repeat(64), signingKeyId: "dbx.release" },
    ];

    expect(selectMarketplaceArtifact(artifacts, "darwin-arm64")?.target).toBe("darwin-arm64");
  });

  it("treats a repository URL and its homepage URL as one link", () => {
    expect(marketplaceHomepageUrl("https://github.com/dbxio/example/", "https://github.com/dbxio/example#readme")).toBeUndefined();
    expect(marketplaceHomepageUrl("https://github.com/dbxio/example", "https://dbxio.com/plugins/example")).toBe("https://dbxio.com/plugins/example");
  });
});

describe("buildInstalledUpdateIndex", () => {
  it("indexes only update-bearing listings by plugin id", () => {
    const index = buildInstalledUpdateIndex(buildMarketplacePluginListings([result], [installed("1.0.0")], "en"));
    expect(index.get("example.hello")).toMatchObject({ repositoryName: "DBX Marketplace" });
    expect(index.get("example.hello")?.listing.plugin.latestVersion).toBe("1.1.0");

    // Already up to date (or not installed) → no entry.
    expect(buildInstalledUpdateIndex(buildMarketplacePluginListings([result], [installed("1.1.0")], "en")).size).toBe(0);
    expect(buildInstalledUpdateIndex(buildMarketplacePluginListings([result], [], "en")).size).toBe(0);
  });

  it("resolves duplicate plugin ids to one source: verifiable repository first, then the higher version", () => {
    const official = repositoryResult("dbx-official", "DBX Marketplace", "1.1.0", true);
    const custom = repositoryResult("acme", "Acme Repo", "1.3.0", false);
    // The unverified custom repository advertises a higher version, but the verifiable official
    // repository wins so the installed tab cannot silently steer users to an unverified source.
    const index = buildInstalledUpdateIndex(buildMarketplacePluginListings([custom, official], [installed("1.0.0")], "en"));
    expect(index.get("example.hello")?.listing.repository.id).toBe("dbx-official");

    const customA = repositoryResult("acme-a", "Acme A", "1.2.0", false);
    const customB = repositoryResult("acme-b", "Acme B", "1.3.0", false);
    const noVerifyIndex = buildInstalledUpdateIndex(buildMarketplacePluginListings([customA, customB], [installed("1.0.0")], "en"));
    expect(noVerifyIndex.get("example.hello")?.listing.plugin.latestVersion).toBe("1.3.0");
  });
});

describe("pluginSourceChange", () => {
  it("returns null when nothing was recorded or the candidate matches the provenance", () => {
    const noProvenance = buildMarketplacePluginListings([result], [installed("1.0.0")], "en")[0];
    expect(pluginSourceChange(noProvenance)).toBeNull();

    const withProvenance = installed("1.0.0");
    withProvenance.provenance = { repositoryId: "dbx-official", publisher: "DBX", signingKeyId: "dbx.release", source: "marketplace" };
    const same = buildMarketplacePluginListings([result], [withProvenance], "en")[0];
    expect(pluginSourceChange(same)).toBeNull();
  });

  it("flags repository, publisher, and signing-key changes individually", () => {
    const moved = installed("1.0.0");
    moved.provenance = { repositoryId: "other-repo", publisher: "DBX", signingKeyId: "dbx.release", source: "marketplace" };
    expect(pluginSourceChange(buildMarketplacePluginListings([result], [moved], "en")[0])).toEqual({ repositoryChanged: true, publisherChanged: false, signingKeyChanged: false });

    const renamed = installed("1.0.0");
    renamed.provenance = { repositoryId: "dbx-official", publisher: "Other", signingKeyId: "dbx.release", source: "marketplace" };
    expect(pluginSourceChange(buildMarketplacePluginListings([result], [renamed], "en")[0])).toEqual({ repositoryChanged: false, publisherChanged: true, signingKeyChanged: false });

    const rekeyed = installed("1.0.0");
    rekeyed.provenance = { repositoryId: "dbx-official", publisher: "DBX", signingKeyId: "dbx.release-2023", source: "marketplace" };
    expect(pluginSourceChange(buildMarketplacePluginListings([result], [rekeyed], "en")[0])).toEqual({ repositoryChanged: false, publisherChanged: false, signingKeyChanged: true });
  });
});

describe("compareVersions", () => {
  it("orders semver, ranks release above prerelease, and falls back for unparsable versions", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0-beta")).toBeGreaterThan(0);
    // Legacy migrated installs can carry non-semver manifest versions; the numeric-aware
    // fallback must still rank the catalog version above them.
    expect(compareVersions("1.1.0", "0.9")).toBeGreaterThan(0);
  });
});

describe("sortMarketplacePluginListings", () => {
  type DatedPluginSpec = { id: string; name: string; latestVersion: string; versions: Array<{ version: string; releasedAt?: string }> };

  function datedPlugin(spec: DatedPluginSpec): PluginMarketplacePlugin {
    return {
      id: spec.id,
      name: spec.name,
      description: "",
      publisher: "DBX",
      verified: true,
      tags: [],
      permissions: [],
      latestVersion: spec.latestVersion,
      versions: spec.versions.map((version) => ({
        version: version.version,
        ...(version.releasedAt ? { releasedAt: version.releasedAt } : {}),
        artifacts: [{ target: "darwin-arm64", url: `https://plugins.example.com/${spec.id}.dbxp`, sha256: "a".repeat(64), signingKeyId: "dbx.release" }],
      })),
    };
  }

  function datedCatalog(plugins: DatedPluginSpec[]): PluginRepositoryCatalogResult {
    return {
      repository: { id: "dbx-official", name: "DBX Marketplace", kind: "official", enabled: true, managed: true },
      target: "darwin-arm64",
      catalog: { catalogVersion: 1, repository: { id: "dbx-official", name: "DBX Marketplace" }, plugins: plugins.map(datedPlugin) },
    };
  }

  const ids = (listings: MarketplacePluginListing[]) => listings.map((listing) => listing.plugin.id);

  // Exactly what the card renders for a listing: the latestVersion entry's date, undated → the
  // sort's -Infinity bucket. Used to pin sort/display coherence without restating the production
  // comparator.
  const displayedTime = (listing: MarketplacePluginListing) => {
    const time = Date.parse(listing.latestVersionReleasedAt || "");
    return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
  };
  const displayedTimes = (listings: MarketplacePluginListing[]) => listings.map(displayedTime);

  it("surfaces the latest version's release date for display and blanks unparsable input", () => {
    const listings = buildMarketplacePluginListings(
      [
        datedCatalog([
          {
            id: "a.hello",
            name: "Alpha",
            latestVersion: "2.0.0",
            versions: [
              { version: "1.0.0", releasedAt: "2026-01-01T00:00:00Z" },
              { version: "2.0.0", releasedAt: "2026-03-01T00:00:00Z" },
            ],
          },
        ]),
      ],
      [],
      "en",
    );

    expect(listings[0].latestVersionReleasedAt).toBe("2026-03-01T00:00:00Z");
    expect(formatMarketplaceReleasedDate(listings[0].latestVersionReleasedAt, "en")).not.toBe("");
    expect(formatMarketplaceReleasedDate(undefined, "en")).toBe("");
    expect(formatMarketplaceReleasedDate("not-a-date", "en")).toBe("");
  });

  it("sorts recently-updated by the displayed latest-version date and sinks undated listings", () => {
    // Beta's OLDER 0.9.0 entry carries the newest date in the catalog, but its card displays the
    // latestVersion (1.0.0) date. The sort key must be that same displayed value, so Beta ties with
    // Alpha instead of ranking above it while showing an older badge.
    const contradictory = datedCatalog([
      { id: "a.old", name: "Alpha", latestVersion: "1.0.0", versions: [{ version: "1.0.0", releasedAt: "2025-01-01T00:00:00Z" }] },
      {
        id: "b.new",
        name: "Beta",
        latestVersion: "1.0.0",
        versions: [
          { version: "1.0.0", releasedAt: "2025-01-01T00:00:00Z" },
          { version: "0.9.0", releasedAt: "2026-05-01T00:00:00Z" },
        ],
      },
      { id: "c.none", name: "Gamma", latestVersion: "1.0.0", versions: [{ version: "1.0.0" }] },
    ]);
    const tied = sortMarketplacePluginListings(buildMarketplacePluginListings([contradictory], [], "en"), "recently-updated");

    // Equal displayed dates → name order; the undated listing sinks to the tail.
    expect(ids(tied)).toEqual(["a.old", "b.new", "c.none"]);

    // The coherence invariant itself: the ranking is exactly the descending order of the field the
    // card renders, with undated listings last. Nothing here looks at Beta's newer 0.9.0 date.
    const dated = datedCatalog([
      { id: "a.new", name: "Alpha", latestVersion: "1.0.0", versions: [{ version: "1.0.0", releasedAt: "2026-06-01T00:00:00Z" }] },
      { id: "b.old", name: "Beta", latestVersion: "1.0.0", versions: [{ version: "1.0.0", releasedAt: "2025-01-01T00:00:00Z" }] },
      { id: "c.none", name: "Gamma", latestVersion: "1.0.0", versions: [{ version: "1.0.0" }] },
    ]);
    const listings = buildMarketplacePluginListings([dated], [], "en");
    const sorted = sortMarketplacePluginListings(listings, "recently-updated");

    expect(ids(sorted)).toEqual(["a.new", "b.old", "c.none"]);
    expect(sorted.map((listing) => listing.latestVersionReleasedAt)).toEqual(["2026-06-01T00:00:00Z", "2025-01-01T00:00:00Z", undefined]);
    // The coherence invariant, stated fixture-independently: walking the sorted list never shows a
    // badge date newer than the entry above it, and the undated listing holds the tail.
    const displayed = displayedTimes(sorted);
    expect(displayed.every((time, index) => index === 0 || displayed[index - 1] >= time)).toBe(true);
    expect(sorted[sorted.length - 1].latestVersionReleasedAt).toBeUndefined();
  });

  it("sorts recently-listed by the earliest version date, including a non-latest version", () => {
    // Unlike "recently updated", this mode intentionally scans every version: no card text claims
    // to show a first-listed date, so min(releasedAt) cannot contradict anything on screen.
    const catalog = datedCatalog([
      {
        id: "a.veteran",
        name: "Alpha",
        latestVersion: "3.0.0",
        versions: [
          { version: "1.0.0", releasedAt: "2024-01-01T00:00:00Z" },
          { version: "3.0.0", releasedAt: "2026-01-01T00:00:00Z" },
        ],
      },
      { id: "b.newcomer", name: "Beta", latestVersion: "1.0.0", versions: [{ version: "1.0.0", releasedAt: "2025-06-01T00:00:00Z" }] },
      // Newest latest-version date of the three, oldest first-listed date is still the veteran's.
      {
        id: "c.young",
        name: "Gamma",
        latestVersion: "1.0.0",
        versions: [
          { version: "1.0.0", releasedAt: "2026-08-01T00:00:00Z" },
          { version: "0.1.0", releasedAt: "2024-06-01T00:00:00Z" },
        ],
      },
    ]);
    const listings = buildMarketplacePluginListings([catalog], [], "en");

    expect(ids(sortMarketplacePluginListings(listings, "recently-listed"))).toEqual(["b.newcomer", "c.young", "a.veteran"]);
  });

  it("puts update-bearing listings first, then the newest-updated order; name mode keeps A–Z", () => {
    // Both plugins have exactly one version, so the latestVersion entry and the single version share
    // a date: updates-first's tie-break uses the same displayed value as "recently-updated".
    const catalog = datedCatalog([
      { id: "a.alpha", name: "Alpha", latestVersion: "2.0.0", versions: [{ version: "2.0.0", releasedAt: "2026-06-01T00:00:00Z" }] },
      { id: "b.zulu", name: "Zulu", latestVersion: "2.0.0", versions: [{ version: "2.0.0", releasedAt: "2025-01-01T00:00:00Z" }] },
    ]);
    const listings = buildMarketplacePluginListings([catalog], [installedFor("b.zulu", "1.0.0")], "en");

    // The builder output itself is the long-standing default: localized name order.
    expect(ids(listings)).toEqual(["a.alpha", "b.zulu"]);
    const updatesFirst = sortMarketplacePluginListings(listings, "updates-first");
    expect(ids(updatesFirst)).toEqual(["b.zulu", "a.alpha"]);
    // The update-bearing listing leads even though its displayed date is the older one.
    expect(displayedTimes(updatesFirst)).toEqual([Date.parse("2025-01-01T00:00:00Z"), Date.parse("2026-06-01T00:00:00Z")]);
    expect(ids(sortMarketplacePluginListings(listings, "name"))).toEqual(["a.alpha", "b.zulu"]);
  });
});
