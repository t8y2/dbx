import type { ConnectionConfig, JdbcDriverInfo, JdbcMavenBundleInfo } from "@/types/database";

export const JDBCX_DRIVER_PROFILE = "jdbcx";
export const JDBCX_JDBC_DRIVER_CLASS = "io.github.jdbcx.WrappedDriver";
export const JDBCX_DEFAULT_URL = "jdbcx:";
export const JDBCX_HIGH_PRIVILEGE_EXTENSIONS_JAVA_OPTION = "-Ddbx.jdbcx.allowHighPrivilegeExtensions=true";
const JDBCX_HIGH_PRIVILEGE_EXTENSIONS_JAVA_OPTION_PREFIX = "-Ddbx.jdbcx.allowHighPrivilegeExtensions=";

export type JdbcxRuntimeDriverApi = {
  listJdbcDrivers: () => Promise<JdbcDriverInfo[]>;
  listJdbcMavenBundles: () => Promise<JdbcMavenBundleInfo[]>;
  jdbcPluginStatus: () => Promise<{ installed: boolean; compatible: boolean }>;
  installJdbcPlugin: () => Promise<unknown>;
};

export type JdbcxRuntimeDriverResult = {
  bundles: JdbcMavenBundleInfo[];
  paths: string[];
  runtimeSelectionId: string;
};

type JdbcxRuntimeCandidate = {
  id: string;
  paths: string[];
  runtimePaths: string[];
};

export function isJdbcxRuntimePath(path: string): boolean {
  return /(?:^|[/\\])jdbcx-driver(?:-|\.)/i.test(path);
}

export function isJdbcxRuntimeBundle(bundle: JdbcMavenBundleInfo): boolean {
  const [groupId, artifactId] = bundle.coordinate.split(":");
  return groupId === "io.github.jdbcx" && artifactId === "jdbcx-driver";
}

export function jdbcxHighPrivilegeExtensionsEnabled(config: Pick<ConnectionConfig, "agent_java_options">): boolean {
  const option = [...(config.agent_java_options ?? [])]
    .reverse()
    .map((value) => value.trim())
    .find((value) => value.startsWith(JDBCX_HIGH_PRIVILEGE_EXTENSIONS_JAVA_OPTION_PREFIX));
  return option?.slice(option.indexOf("=") + 1).toLowerCase() === "true";
}

export function setJdbcxHighPrivilegeExtensionsEnabled(config: Pick<ConnectionConfig, "agent_java_options">, enabled: boolean): void {
  // Canonicalize this DBX-owned option so legacy whitespace cannot diverge from backend parsing.
  const options = (config.agent_java_options ?? []).filter((option) => !option.trim().startsWith(JDBCX_HIGH_PRIVILEGE_EXTENSIONS_JAVA_OPTION_PREFIX));
  config.agent_java_options = enabled ? [...options, JDBCX_HIGH_PRIVILEGE_EXTENSIONS_JAVA_OPTION] : options;
}

function runtimeCandidates(bundles: JdbcMavenBundleInfo[], installedDrivers: JdbcDriverInfo[], configuredPaths: string[]): JdbcxRuntimeCandidate[] {
  const bundleCandidates = bundles.filter(isJdbcxRuntimeBundle).map((bundle) => {
    const paths = bundle.artifacts.map((artifact) => artifact.path).filter(Boolean);
    return {
      id: `maven:${bundle.id}`,
      paths,
      runtimePaths: paths.filter(isJdbcxRuntimePath),
    };
  });
  const mavenBundleIds = new Set(bundles.map((bundle) => bundle.id));
  const installedBundlePaths = new Map<string, string[]>();
  for (const driver of installedDrivers) {
    if (!driver.bundle_id || mavenBundleIds.has(driver.bundle_id)) continue;
    installedBundlePaths.set(driver.bundle_id, [...(installedBundlePaths.get(driver.bundle_id) ?? []), driver.path]);
  }
  const localBundleCandidates = [...installedBundlePaths].map(([bundleId, paths]) => ({
    id: `local:${bundleId}`,
    paths,
    runtimePaths: paths.filter(isJdbcxRuntimePath),
  }));
  const standaloneCandidates = installedDrivers.filter((driver) => !driver.bundle_id && isJdbcxRuntimePath(driver.path)).map((driver) => ({ id: `manual:${driver.path}`, paths: [driver.path], runtimePaths: [driver.path] }));
  const knownRuntimePaths = new Set([...bundleCandidates, ...localBundleCandidates, ...standaloneCandidates].flatMap((candidate) => candidate.runtimePaths));
  const configuredCandidates = configuredPaths.filter((path) => isJdbcxRuntimePath(path) && !knownRuntimePaths.has(path)).map((path) => ({ id: `manual:${path}`, paths: [path], runtimePaths: [path] }));
  return [...bundleCandidates, ...localBundleCandidates, ...standaloneCandidates, ...configuredCandidates].filter((candidate) => candidate.runtimePaths.length > 0);
}

function selectRuntimeCandidate(candidates: JdbcxRuntimeCandidate[], configuredPaths: string[]): JdbcxRuntimeCandidate {
  const configured = new Set(configuredPaths);
  const selected = candidates.filter((candidate) => candidate.runtimePaths.some((path) => configured.has(path)));
  if (selected.length > 1) {
    throw new Error("Multiple JDBCX runtimes are selected. Keep exactly one JDBCX bundle/runtime in Driver JARs, then retry.");
  }
  if (selected.length === 1) return selected[0];
  if (candidates.length > 0) {
    throw new Error("JDBCX runtime is installed but not selected. Select exactly one JDBCX bundle/runtime in Driver JARs, then retry.");
  }
  throw new Error("JDBCX runtime is not installed. Install io.github.jdbcx:jdbcx-driver:<version> in Driver Store, then retry.");
}

export async function ensureJdbcxRuntimeDrivers(config: ConnectionConfig, api: JdbcxRuntimeDriverApi, onInstalling?: (coordinates: string[]) => void): Promise<JdbcxRuntimeDriverResult | undefined> {
  if (config.db_type !== "jdbc" || config.driver_profile !== JDBCX_DRIVER_PROFILE) return undefined;

  config.connection_string = config.connection_string?.trim() || JDBCX_DEFAULT_URL;
  config.jdbc_driver_class = config.jdbc_driver_class?.trim() || JDBCX_JDBC_DRIVER_CLASS;
  const configuredPaths = (config.jdbc_driver_paths ?? []).map((path) => path.trim()).filter(Boolean);
  const pluginStatus = await api.jdbcPluginStatus();
  if (!pluginStatus.installed || !pluginStatus.compatible) {
    onInstalling?.([]);
    await api.installJdbcPlugin();
  }

  const [bundles, installedDrivers] = await Promise.all([api.listJdbcMavenBundles(), api.listJdbcDrivers()]);
  const candidates = runtimeCandidates(bundles, installedDrivers, configuredPaths);
  const selectedRuntime = selectRuntimeCandidate(candidates, configuredPaths);
  const installedRuntimeArtifacts = new Set(candidates.flatMap((candidate) => candidate.paths));
  const selectedDriverPaths = configuredPaths.filter((path) => !installedRuntimeArtifacts.has(path));
  const paths = Array.from(new Set([...selectedDriverPaths, ...selectedRuntime.paths]));

  // JDBCX discovers the delegate driver through JDBC ServiceLoader/Driver.acceptsURL.
  // Keep the classpath scoped to the connection-selected vendor driver and the
  // JDBCX runtime so unrelated driver dependencies cannot conflict.
  config.jdbc_driver_paths = paths;
  return { bundles, paths, runtimeSelectionId: selectedRuntime.id };
}
