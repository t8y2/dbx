import type { AgentDriverInfo } from "@/lib/backend/api";
import type { JdbcDriverInfo, JdbcMavenBundleInfo, JdbcPluginStatus } from "@/types/database";

export type ManagedJdbcBundleDefinition = {
  coordinate: string;
  repositories: readonly string[];
};

export type ManagedJdbcDriverDefinition = {
  id: string;
  label: string;
  version: string;
  jre: string;
  bundles: readonly ManagedJdbcBundleDefinition[];
};

export type ManagedJdbcDriverApi = {
  installJdbcPlugin: () => Promise<JdbcPluginStatus>;
  installJdbcDriverFromMaven: (coordinate: string, repositories?: string[]) => Promise<JdbcDriverInfo[]>;
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

export function managedJdbcDriverBundles(definition: ManagedJdbcDriverDefinition, bundles: readonly JdbcMavenBundleInfo[]): JdbcMavenBundleInfo[] {
  const bundleByCoordinate = new Map(bundles.map((bundle) => [bundle.coordinate, bundle]));
  return definition.bundles.map(({ coordinate }) => bundleByCoordinate.get(coordinate)).filter((bundle): bundle is JdbcMavenBundleInfo => Boolean(bundle));
}

export function missingManagedJdbcDriverBundles(definition: ManagedJdbcDriverDefinition, bundles: readonly JdbcMavenBundleInfo[]): ManagedJdbcBundleDefinition[] {
  const installedCoordinates = new Set(bundles.map((bundle) => bundle.coordinate));
  return definition.bundles.filter(({ coordinate }) => !installedCoordinates.has(coordinate));
}

export function managedJdbcDriverPaths(definition: ManagedJdbcDriverDefinition, bundles: readonly JdbcMavenBundleInfo[], coordinates: readonly string[] = definition.bundles.map(({ coordinate }) => coordinate)): string[] {
  const bundleByCoordinate = new Map(managedJdbcDriverBundles(definition, bundles).map((bundle) => [bundle.coordinate, bundle]));
  const requiredBundles = coordinates.map((coordinate) => bundleByCoordinate.get(coordinate));
  if (requiredBundles.some((bundle) => !bundle)) return [];
  return requiredBundles.flatMap((bundle) => (bundle?.artifacts ?? []).map((artifact) => artifact.path).filter(Boolean));
}

export function managedJdbcDriverRow(definition: ManagedJdbcDriverDefinition, bundles: readonly JdbcMavenBundleInfo[], pluginStatus?: Pick<JdbcPluginStatus, "installed" | "compatible"> | null): AgentDriverInfo {
  const installedBundles = managedJdbcDriverBundles(definition, bundles);
  const pluginReady = pluginStatus?.installed === true && pluginStatus.compatible;
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

export async function installManagedJdbcDriver(definition: ManagedJdbcDriverDefinition, currentBundles: readonly JdbcMavenBundleInfo[], currentPluginStatus: Pick<JdbcPluginStatus, "installed" | "compatible"> | null | undefined, api: ManagedJdbcDriverApi): Promise<ManagedJdbcDriverMutationResult> {
  let pluginStatus: JdbcPluginStatus | undefined;
  if (!currentPluginStatus?.installed || !currentPluginStatus.compatible) {
    pluginStatus = await api.installJdbcPlugin();
  }

  let bundles = [...currentBundles];
  let drivers: JdbcDriverInfo[] | undefined;
  for (const bundle of definition.bundles) {
    if (bundles.some(({ coordinate }) => coordinate === bundle.coordinate)) continue;
    drivers = await api.installJdbcDriverFromMaven(bundle.coordinate, [...bundle.repositories]);
    bundles = await api.listJdbcMavenBundles();
  }
  return { drivers, bundles, pluginStatus };
}

export async function uninstallManagedJdbcDriver(definition: ManagedJdbcDriverDefinition, currentBundles: readonly JdbcMavenBundleInfo[], api: ManagedJdbcDriverApi): Promise<ManagedJdbcDriverMutationResult> {
  let drivers: JdbcDriverInfo[] | undefined;
  for (const bundle of managedJdbcDriverBundles(definition, currentBundles)) {
    drivers = await api.deleteJdbcMavenBundle(bundle.id);
  }
  const bundles = await api.listJdbcMavenBundles();
  return { drivers, bundles };
}
