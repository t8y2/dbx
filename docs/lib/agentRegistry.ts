const R2_CDN_BASE = "https://dl.dbxio.com";

function filenameFromUrl(url: string): string {
  return url.split("/").pop() ?? url;
}

function githubUrlToR2Url(url: string, category: "jre" | "driver"): string {
  const filename = filenameFromUrl(url);
  return `${R2_CDN_BASE}/agents/${category}/${filename}`;
}

export interface ArtifactInfo {
  url: string;
  size: number;
}

export interface JreInfo {
  version: string;
  platforms: Record<string, ArtifactInfo>;
}

export interface DriverInfo {
  version: string;
  label: string;
  min_app_version: string;
  jar: ArtifactInfo;
  jre: string;
}

export interface AgentRegistry {
  jre?: JreInfo;
  jres?: Record<string, JreInfo>;
  drivers: Record<string, DriverInfo>;
}

const AGENT_REGISTRY_R2_URL = "https://dl.dbxio.com/agents/agent-registry.json";
const AGENT_REGISTRY_GITHUB_URL = "https://github.com/t8y2/dbx-agents/releases/latest/download/agent-registry.json";

export async function fetchAgentRegistry(): Promise<AgentRegistry | null> {
  const urls = [AGENT_REGISTRY_R2_URL, AGENT_REGISTRY_GITHUB_URL];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        return (await res.json()) as AgentRegistry;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export interface JreDisplayEntry {
  platformKey: string;
  platformLabel: string;
  info: ArtifactInfo;
  jreVersion: string;
  jreKey: string;
  r2Url: string;
}

export interface DriverDisplayEntry {
  key: string;
  label: string;
  version: string;
  minAppVersion: string;
  jar: ArtifactInfo;
  jre: string;
  r2Url: string;
}

export function buildJreEntries(registry: AgentRegistry): JreDisplayEntry[] {
  const entries: JreDisplayEntry[] = [];
  const platformLabels: Record<string, string> = {
    "macos-aarch64": "macOS (Apple Silicon)",
    "macos-x64": "macOS (Intel)",
    "linux-aarch64": "Linux (ARM64)",
    "linux-x64": "Linux (x64)",
    "windows-aarch64": "Windows (ARM64)",
    "windows-x64": "Windows (x64)",
  };

  const jres = registry.jres ?? {};
  for (const [key, jreInfo] of Object.entries(jres)) {
    for (const [platformKey, artifact] of Object.entries(jreInfo.platforms)) {
      entries.push({
        platformKey,
        platformLabel: platformLabels[platformKey] ?? platformKey,
        info: artifact,
        jreVersion: jreInfo.version,
        jreKey: key,
        r2Url: githubUrlToR2Url(artifact.url, "jre"),
      });
    }
  }

  if (entries.length === 0 && registry.jre) {
    for (const [platformKey, artifact] of Object.entries(registry.jre.platforms)) {
      entries.push({
        platformKey,
        platformLabel: platformLabels[platformKey] ?? platformKey,
        info: artifact,
        jreVersion: registry.jre.version,
        jreKey: "21",
        r2Url: githubUrlToR2Url(artifact.url, "jre"),
      });
    }
  }

  return entries;
}

export function buildDriverEntries(registry: AgentRegistry): DriverDisplayEntry[] {
  return Object.entries(registry.drivers).map(([key, info]) => ({
    key,
    label: info.label,
    version: info.version,
    minAppVersion: info.min_app_version,
    jar: info.jar,
    jre: info.jre,
    r2Url: githubUrlToR2Url(info.jar.url, "driver"),
  }));
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
