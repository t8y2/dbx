import type { TenantConfig } from "@/types/mq";

export function normalizeClusterOptions(clusters: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const cluster of clusters) {
    if (typeof cluster !== "string") continue;
    const name = cluster.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }

  return result;
}

export function mqClusterOptionsFromExtra(extra: unknown): string[] {
  if (!extra || typeof extra !== "object") return [];

  const clusters = (extra as { clusters?: unknown }).clusters;
  if (!Array.isArray(clusters)) return [];

  return normalizeClusterOptions(clusters);
}

export function defaultTenantConfig(clusterOptions: readonly string[]): TenantConfig {
  return {
    adminRoles: [],
    allowedClusters: normalizeClusterOptions(clusterOptions),
  };
}

export function validateTenantForm(name: string | undefined, config: TenantConfig): string | undefined {
  if (!name?.trim()) {
    return "Tenant name is required";
  }
  if (!normalizeClusterOptions(config.allowedClusters).length) {
    return "Allowed clusters are required";
  }
  return undefined;
}
