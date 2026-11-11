import type { AgentDriverInfo } from "@/lib/backend/api";
import type { JdbcDriverInfo, JdbcMavenBundleInfo, JdbcPluginStatus } from "@/types/database";

export type ManagedJdbcBundleDefinition = {
  coordinate: string;
  repositories: readonly string[];
  compatibilityRuntimeId?: string;
  requiredArtifactNames?: readonly string[];
};

export type ManagedJdbcDriverDefinition = {
  id: string;
  label: string;
  labelKey?: string;
  requiredPluginCapabilities?: readonly string[];
  version: string;
  jre: string;
  bundles: readonly ManagedJdbcBundleDefinition[];
};

export type ManagedJdbcDriverApi = {
  installJdbcPlugin: () => Promise<JdbcPluginStatus>;
  installJdbcDriverFromMaven: (coordinate: string, repositories?: string[]) => Promise<JdbcDriverInfo[]>;
  installJdbcCompatibilityRuntime?: (id: string) => Promise<JdbcDriverInfo[]>;
  listJdbcMavenBundles: () => Promise<JdbcMavenBundleInfo[]>;
  deleteJdbcMavenBundle: (bundleId: string) => Promise<JdbcDriverInfo[]>;
};

export type ManagedJdbcDriverMutationResult = {
  drivers?: JdbcDriverInfo[];
  bundles: JdbcMavenBundleInfo[];
  pluginStatus?: JdbcPluginStatus;
};

export type ManagedJdbcDriverRegistry = {
  definitions: readonly ManagedJdbcDriverDefinition[];
  byId: ReadonlyMap<string, ManagedJdbcDriverDefinition>;
};

export function createManagedJdbcDriverRegistry(definitions: readonly ManagedJdbcDriverDefinition[]): ManagedJdbcDriverRegistry {
  const byId = new Map<string, ManagedJdbcDriverDefinition>();
  const coordinateOwners = new Map<string, string>();
  for (const definition of definitions) {
    if (!definition.id.trim()) throw new Error("Managed JDBC driver id must not be empty");
    if (byId.has(definition.id)) throw new Error(`Duplicate managed JDBC driver id: ${definition.id}`);
    if (definition.bundles.length === 0) throw new Error(`Managed JDBC driver must own at least one bundle: ${definition.id}`);
    for (const bundle of definition.bundles) {
      const owner = coordinateOwners.get(bundle.coordinate);
      if (owner) throw new Error(`Managed JDBC coordinate ${bundle.coordinate} is owned by both ${owner} and ${definition.id}`);
      coordinateOwners.set(bundle.coordinate, definition.id);
    }
    byId.set(definition.id, definition);
  }
  return { definitions: [...definitions], byId };
}

export function jdbcBundleHasArtifacts(bundle: JdbcMavenBundleInfo | undefined, requiredArtifactNames: readonly string[] = []): boolean {
  if (!bundle) return false;
  if (requiredArtifactNames.length === 0) return true;
  if (bundle.artifacts.length === 0 || bundle.artifacts.some((artifact) => !artifact.path)) return false;
  return requiredArtifactNames.every((name) => bundle.artifacts.some((artifact) => artifact.file_name === name));
}

export function managedJdbcDriverBundles(definition: ManagedJdbcDriverDefinition, bundles: readonly JdbcMavenBundleInfo[]): JdbcMavenBundleInfo[] {
  const bundleByCoordinate = new Map(bundles.map((bundle) => [bundle.coordinate, bundle]));
  return definition.bundles
    .map(({ coordinate, requiredArtifactNames }) => {
      const bundle = bundleByCoordinate.get(coordinate);
      return jdbcBundleHasArtifacts(bundle, requiredArtifactNames) ? bundle : undefined;
    })
    .filter((bundle): bundle is JdbcMavenBundleInfo => Boolean(bundle));
}

export function missingManagedJdbcDriverBundles(definition: ManagedJdbcDriverDefinition, bundles: readonly JdbcMavenBundleInfo[]): ManagedJdbcBundleDefinition[] {
  const installedCoordinates = new Set(managedJdbcDriverBundles(definition, bundles).map((bundle) => bundle.coordinate));
  return definition.bundles.filter(({ coordinate }) => !installedCoordinates.has(coordinate));
}

export function managedJdbcDriverPaths(definition: ManagedJdbcDriverDefinition, bundles: readonly JdbcMavenBundleInfo[], coordinates: readonly string[] = definition.bundles.map(({ coordinate }) => coordinate)): string[] {
  const bundleByCoordinate = new Map(managedJdbcDriverBundles(definition, bundles).map((bundle) => [bundle.coordinate, bundle]));
  const requiredBundles = coordinates.map((coordinate) => bundleByCoordinate.get(coordinate));
  if (requiredBundles.some((bundle) => !bundle)) return [];
  return requiredBundles.flatMap((bundle) => (bundle?.artifacts ?? []).map((artifact) => artifact.path).filter(Boolean));
}

export function managedJdbcPluginReady(definition: ManagedJdbcDriverDefinition, status?: Pick<JdbcPluginStatus, "installed" | "compatible" | "capabilities"> | null): boolean {
  return status?.installed === true && status.compatible && (definition.requiredPluginCapabilities ?? []).every((capability) => (status.capabilities ?? []).includes(capability));
}

export class ManagedJdbcPluginCapabilityError extends Error {
  constructor() {
    super("Update the JDBC plugin to a release with external classpath isolation before installing this compatibility runtime.");
    this.name = "ManagedJdbcPluginCapabilityError";
  }
}

export async function importManagedJdbcCompatibilityRuntime(
  definition: ManagedJdbcDriverDefinition,
  status: Pick<JdbcPluginStatus, "installed" | "compatible" | "capabilities"> | null | undefined,
  file: string | File,
  api: { installJdbcCompatibilityRuntimeFromFile: (id: string, file: string | File) => Promise<JdbcDriverInfo[]> },
): Promise<JdbcDriverInfo[]> {
  if (!managedJdbcPluginReady(definition, status)) throw new ManagedJdbcPluginCapabilityError();
  const id = definition.bundles.find((bundle) => bundle.compatibilityRuntimeId)?.compatibilityRuntimeId;
  if (!id) throw new Error("Compatibility runtime import is unavailable");
  return api.installJdbcCompatibilityRuntimeFromFile(id, file);
}

export function managedJdbcDriverRow(definition: ManagedJdbcDriverDefinition, bundles: readonly JdbcMavenBundleInfo[], pluginStatus?: Pick<JdbcPluginStatus, "installed" | "compatible" | "capabilities"> | null): AgentDriverInfo {
  const installedBundles = managedJdbcDriverBundles(definition, bundles);
  const pluginReady = managedJdbcPluginReady(definition, pluginStatus);
  const installed = pluginReady && installedBundles.length === definition.bundles.length;
  return {
    db_type: definition.id,
    label: definition.label,
    version: definition.version,
    size: installedBundles.reduce((bundleTotal, bundle) => bundleTotal + bundle.artifacts.reduce((artifactTotal, artifact) => artifactTotal + Number(artifact.size || 0), 0), 0),
    installed,
    installed_version: installed ? definition.version : null,
    update_available: false,
    requires_java_runtime: true,
    jre: definition.jre,
    jre_installed: true,
  };
}

export async function installManagedJdbcDriver(
  definition: ManagedJdbcDriverDefinition,
  currentBundles: readonly JdbcMavenBundleInfo[],
  currentPluginStatus: Pick<JdbcPluginStatus, "installed" | "compatible" | "capabilities"> | null | undefined,
  api: ManagedJdbcDriverApi,
): Promise<ManagedJdbcDriverMutationResult> {
  let pluginStatus: JdbcPluginStatus | undefined;
  if (!managedJdbcPluginReady(definition, currentPluginStatus)) {
    pluginStatus = await api.installJdbcPlugin();
  }
  if (definition.requiredPluginCapabilities?.length && !managedJdbcPluginReady(definition, pluginStatus ?? currentPluginStatus)) {
    throw new ManagedJdbcPluginCapabilityError();
  }

  let bundles = [...currentBundles];
  let drivers: JdbcDriverInfo[] | undefined;
  for (const bundle of definition.bundles) {
    if (bundles.some((installed) => installed.coordinate === bundle.coordinate && jdbcBundleHasArtifacts(installed, bundle.requiredArtifactNames))) continue;
    if (bundle.compatibilityRuntimeId) {
      if (!api.installJdbcCompatibilityRuntime) throw new Error("Compatibility runtime installation is unavailable");
      drivers = await api.installJdbcCompatibilityRuntime(bundle.compatibilityRuntimeId);
    } else {
      drivers = await api.installJdbcDriverFromMaven(bundle.coordinate, [...bundle.repositories]);
    }
    bundles = await api.listJdbcMavenBundles();
  }
  return { drivers, bundles, pluginStatus };
}

export async function uninstallManagedJdbcDriver(definition: ManagedJdbcDriverDefinition, currentBundles: readonly JdbcMavenBundleInfo[], api: ManagedJdbcDriverApi): Promise<ManagedJdbcDriverMutationResult> {
  let drivers: JdbcDriverInfo[] | undefined;
  for (const bundle of currentBundles.filter((installed) => definition.bundles.some(({ coordinate }) => coordinate === installed.coordinate))) {
    drivers = await api.deleteJdbcMavenBundle(bundle.id);
  }
  const bundles = await api.listJdbcMavenBundles();
  return { drivers, bundles };
}
