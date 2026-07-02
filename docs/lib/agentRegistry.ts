import driverVersions from "../../agents/versions.json";

export interface ArtifactInfo {
  url: string;
  size: number;
}

export interface GitHubReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GitHubRelease {
  assets?: GitHubReleaseAsset[];
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

export interface AgentDownloadCatalog {
  bundles: OfflineBundleEntry[];
  drivers: DriverDisplayEntry[];
  jres: JreDisplayEntry[];
  nativeAgents: NativeAgentDisplayEntry[];
}

const AGENTS_LATEST_RELEASE_API_URL = "https://api.github.com/repos/t8y2/dbx/releases/tags/agents-latest";
const MIN_APP_VERSION = "0.6.0";
const driverVersionMap = driverVersions as Record<string, string>;
const nativeDriverKeys = new Set(["oracle", "xugu"]);

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

function assetMap(assets: GitHubReleaseAsset[]): Map<string, GitHubReleaseAsset> {
  return new Map(assets.map((asset) => [asset.name, asset]));
}

export async function fetchAgentDownloadCatalog(): Promise<AgentDownloadCatalog | null> {
  try {
    const res = await fetch(AGENTS_LATEST_RELEASE_API_URL, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;

    const release = (await res.json()) as GitHubRelease;
    return buildAgentDownloadCatalog(release.assets ?? []);
  } catch {
    return null;
  }
}

export function buildAgentDownloadCatalog(assets: GitHubReleaseAsset[]): AgentDownloadCatalog {
  return {
    bundles: buildOfflineBundleEntries(assets),
    drivers: buildDriverEntries(assets),
    jres: buildJreEntries(assets),
    nativeAgents: buildNativeAgentEntries(assets),
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
    const match = /^dbx-agent-(oracle|xugu)-(.+?)(?:\.exe)?$/.exec(asset.name);
    if (!match) continue;

    const [, key, platformKey] = match;
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
