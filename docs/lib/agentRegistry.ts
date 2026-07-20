import driverVersions from "../../agents/versions.json";

export interface ArtifactInfo {
  url: string;
  size: number;
}

export type DownloadSource = "github" | "cnb" | "official";

export interface DownloadLink {
  source: DownloadSource;
  url: string;
}

export interface GitHubReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GitHubRelease {
  assets?: GitHubReleaseAsset[];
}

interface AgentRegistryArtifact {
  url: string;
  size: number;
}

interface AgentRegistryDriver {
  jar?: AgentRegistryArtifact;
  native?: Record<string, AgentRegistryArtifact>;
}

interface AgentRegistry {
  jres?: Record<string, { platforms?: Record<string, AgentRegistryArtifact> }>;
  drivers?: Record<string, AgentRegistryDriver>;
}

export interface OfflineBundleEntry {
  platformKey: string;
  platformLabel: string;
  filename: string;
  size: number;
  url: string;
}

export interface JreDisplayEntry {
  platformKey: string;
  platformLabel: string;
  info: ArtifactInfo;
  jreVersion: string;
  jreKey: string;
}

export interface DriverDisplayEntry {
  key: string;
  label: string;
  version: string;
  minAppVersion: string;
  jar: ArtifactInfo;
  jre: string;
}

export interface NativeAgentDisplayEntry {
  key: string;
  label: string;
  version: string;
  platformKey: string;
  platformLabel: string;
  filename: string;
  info: ArtifactInfo;
}

export interface JdbcPluginDownloadEntry {
  label: string;
  filename: string;
  url: string;
}

export interface AgentDownloadCatalog {
  jdbcPlugin: JdbcPluginDownloadEntry;
  bundles: OfflineBundleEntry[];
  drivers: DriverDisplayEntry[];
  jres: JreDisplayEntry[];
  nativeAgents: NativeAgentDisplayEntry[];
}

const AGENTS_LATEST_RELEASE_API_URL = "https://api.github.com/repos/t8y2/dbx/releases/tags/agents-latest";
const CNB_AGENT_REGISTRY_URL = "https://cnb.cool/dbxio.com/dbx/-/releases/download/agents-latest/agent-registry.json";
const JDBC_PLUGIN_DOWNLOAD_URL = "https://dl.dbxio.com/releases/latest/dbx-jdbc-plugin-latest.zip";
const GITHUB_RELEASE_DOWNLOAD_PREFIX = "https://github.com/t8y2/dbx/releases/download/";
const CNB_RELEASE_DOWNLOAD_PREFIX = "https://cnb.cool/dbxio.com/dbx/-/releases/download/";
const MIN_APP_VERSION = "0.6.0";
const driverVersionMap = driverVersions as Record<string, string>;
const nativeDriverKeys = new Set(["oracle", "kingbase", "xugu"]);

const platformLabels: Record<string, string> = {
  "macos-aarch64": "macOS (Apple Silicon)",
  "macos-x64": "macOS (Intel)",
  "linux-aarch64": "Linux (ARM64)",
  "linux-x64": "Linux (x64)",
  "windows-aarch64": "Windows (ARM64)",
  "windows-x64": "Windows (x64)",
};

const driverLabels: Record<string, string> = {
  access: "Microsoft Access",
  bigquery: "BigQuery",
  cassandra: "Cassandra",
  dameng: "Dameng",
  databend: "Databend",
  databricks: "Databricks",
  db2: "DB2",
  etcd: "etcd",
  exasol: "Exasol",
  firebird: "Firebird",
  gbase8a: "GBase 8a",
  gbase8s: "GBase 8s",
  goldendb: "GoldenDB",
  h2: "H2",
  highgo: "HighGo",
  hive: "Hive",
  informix: "Informix",
  iotdb: "Apache IoTDB",
  iris: "InterSystems IRIS",
  kingbase: "KingBase",
  kylin: "Apache Kylin",
  mongodb: "MongoDB (Legacy)",
  neo4j: "Neo4j",
  "oceanbase-oracle": "OceanBase Oracle Mode",
  oracle: "Oracle",
  saphana: "SAP HANA",
  snowflake: "Snowflake",
  sundb: "SunDB",
  tdengine: "TDengine",
  teradata: "Teradata",
  trino: "Trino",
  vastbase: "Vastbase",
  vertica: "Vertica",
  xugu: "虚谷 XuguDB",
  yashandb: "YashanDB",
  zookeeper: "ZooKeeper",
};

const currentDriverKeys = Object.keys(driverVersionMap).sort((a, b) => labelForDriver(a).localeCompare(labelForDriver(b)));
const currentJavaDriverKeys = currentDriverKeys.filter((key) => !nativeDriverKeys.has(key));

const jreVersions: Record<string, string> = {
  "21": "21",
};

function labelForDriver(key: string): string {
  return driverLabels[key] ?? key.replace(/-/g, " ");
}

function assetInfo(asset: GitHubReleaseAsset): ArtifactInfo {
  return {
    url: asset.browser_download_url,
    size: asset.size,
  };
}

function releaseAssetName(url: string, fallback: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || fallback);
  } catch {
    return fallback;
  }
}

function githubReleaseAsset(name: string, size: number, tag = "agents-latest"): GitHubReleaseAsset {
  return {
    name,
    size,
    browser_download_url: `${GITHUB_RELEASE_DOWNLOAD_PREFIX}${tag}/${name}`,
  };
}

function registryReleaseAssets(registry: AgentRegistry): GitHubReleaseAsset[] {
  const assets = new Map<string, GitHubReleaseAsset>();
  const addArtifact = (artifact: AgentRegistryArtifact | undefined, fallbackName: string) => {
    if (!artifact?.url) return;
    const name = releaseAssetName(artifact.url, fallbackName);
    assets.set(name, { name, size: artifact.size || 0, browser_download_url: artifact.url });
  };

  for (const [jreKey, jre] of Object.entries(registry.jres ?? {})) {
    for (const [platformKey, artifact] of Object.entries(jre.platforms ?? {})) {
      addArtifact(artifact, `dbx-jre-${jreKey}-${platformKey}.tar.gz`);
    }
  }

  for (const [driverKey, driver] of Object.entries(registry.drivers ?? {})) {
    addArtifact(driver.jar, `dbx-agent-${driverKey}.jar`);
    for (const [platformKey, artifact] of Object.entries(driver.native ?? {})) {
      addArtifact(artifact, `dbx-agent-${driverKey}-${platformKey}`);
    }
  }

  for (const platformKey of Object.keys(registry.jres?.["21"]?.platforms ?? {})) {
    const name = `dbx-agents-offline-${platformKey}.zip`;
    assets.set(name, githubReleaseAsset(name, 0));
  }

  return Array.from(assets.values());
}

function hasDownloadAssets(catalog: AgentDownloadCatalog): boolean {
  return catalog.bundles.length > 0 || catalog.drivers.length > 0 || catalog.jres.length > 0 || catalog.nativeAgents.length > 0;
}

async function fetchJson<T>(url: string, headers?: HeadersInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", headers });
  if (!response.ok) throw new Error(`Download catalog request failed with ${response.status}`);
  return response.json() as Promise<T>;
}

export function downloadLinksFor(url: string): DownloadLink[] {
  const releasePath = url.startsWith(GITHUB_RELEASE_DOWNLOAD_PREFIX) ? url.slice(GITHUB_RELEASE_DOWNLOAD_PREFIX.length) : null;
  if (!releasePath) return [{ source: "official", url }];

  return [
    { source: "github", url },
    { source: "cnb", url: `${CNB_RELEASE_DOWNLOAD_PREFIX}${releasePath}` },
  ];
}

function assetMap(assets: GitHubReleaseAsset[]): Map<string, GitHubReleaseAsset> {
  return new Map(assets.map((asset) => [asset.name, asset]));
}

export async function fetchAgentDownloadCatalog(): Promise<AgentDownloadCatalog | null> {
  const loaders: Array<() => Promise<GitHubReleaseAsset[]>> = [
    async () => (await fetchJson<GitHubRelease>(AGENTS_LATEST_RELEASE_API_URL, { Accept: "application/vnd.github+json" })).assets ?? [],
    async () => registryReleaseAssets(await fetchJson<AgentRegistry>(CNB_AGENT_REGISTRY_URL)),
  ];

  for (const loadAssets of loaders) {
    try {
      const catalog = buildAgentDownloadCatalog(await loadAssets());
      if (hasDownloadAssets(catalog)) return catalog;
    } catch {
      // Try the next synchronized release source.
    }
  }

  return null;
}

export function buildAgentDownloadCatalog(assets: GitHubReleaseAsset[]): AgentDownloadCatalog {
  return {
    jdbcPlugin: buildJdbcPluginDownloadEntry(),
    bundles: buildOfflineBundleEntries(assets),
    drivers: buildDriverEntries(assets),
    jres: buildJreEntries(assets),
    nativeAgents: buildNativeAgentEntries(assets),
  };
}

export function buildJdbcPluginDownloadEntry(): JdbcPluginDownloadEntry {
  return {
    label: "DBX JDBC Plugin",
    filename: "dbx-jdbc-plugin-latest.zip",
    url: JDBC_PLUGIN_DOWNLOAD_URL,
  };
}

export function buildJreEntries(assets: GitHubReleaseAsset[]): JreDisplayEntry[] {
  return assets
    .map((asset) => {
      const match = /^dbx-jre-(\d+)-(.+)\.tar\.gz$/.exec(asset.name);
      if (!match) return null;

      const [, jreKey, platformKey] = match;
      if (!jreVersions[jreKey]) return null;

      return {
        platformKey,
        platformLabel: platformLabels[platformKey] ?? platformKey,
        info: assetInfo(asset),
        jreVersion: jreVersions[jreKey],
        jreKey,
      };
    })
    .filter((entry): entry is JreDisplayEntry => entry !== null)
    .sort((a, b) => a.platformLabel.localeCompare(b.platformLabel));
}

export function buildDriverEntries(assets: GitHubReleaseAsset[]): DriverDisplayEntry[] {
  const byName = assetMap(assets);

  return currentJavaDriverKeys
    .map((key) => {
      const asset = byName.get(`dbx-agent-${key}.jar`);
      if (!asset) return null;

      return {
        key,
        label: labelForDriver(key),
        version: driverVersionMap[key] ?? "",
        minAppVersion: MIN_APP_VERSION,
        jar: assetInfo(asset),
        jre: "21",
      };
    })
    .filter((entry): entry is DriverDisplayEntry => entry !== null);
}

export function buildNativeAgentEntries(assets: GitHubReleaseAsset[]): NativeAgentDisplayEntry[] {
  const entries: NativeAgentDisplayEntry[] = [];

  for (const asset of assets) {
    const match = /^dbx-agent-(.+?)-(macos-aarch64|macos-x64|linux-aarch64|linux-x64|windows-aarch64|windows-x64)(?:\.exe)?$/.exec(asset.name);
    if (!match) continue;

    const [, key, platformKey] = match;
    if (!nativeDriverKeys.has(key)) continue;
    entries.push({
      key,
      label: labelForDriver(key),
      version: driverVersionMap[key] ?? "",
      platformKey,
      platformLabel: platformLabels[platformKey] ?? platformKey,
      filename: asset.name,
      info: assetInfo(asset),
    });
  }

  return entries.sort((a, b) => a.label.localeCompare(b.label) || a.platformLabel.localeCompare(b.platformLabel));
}

export function buildOfflineBundleEntries(assets: GitHubReleaseAsset[]): OfflineBundleEntry[] {
  return assets
    .map((asset) => {
      const match = /^dbx-agents-offline-(.+)\.zip$/.exec(asset.name);
      if (!match) return null;
      const platformKey = match[1];
      return {
        platformKey,
        platformLabel: platformLabels[platformKey] ?? platformKey,
        filename: asset.name,
        size: asset.size,
        url: asset.browser_download_url,
      };
    })
    .filter((entry): entry is OfflineBundleEntry => entry !== null)
    .sort((a, b) => a.platformLabel.localeCompare(b.platformLabel));
}

export function formatSize(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}
