import { describe, expect, it } from "vitest";
import { buildInstalledUpdateIndex, buildMarketplacePluginListings, compareVersions, filterMarketplacePluginListings, marketplaceHomepageUrl, pluginSourceChange, selectMarketplaceArtifact } from "./pluginMarketplace";
import type { InstalledPlugin, PluginRepositoryCatalogResult } from "@/types/database";

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
