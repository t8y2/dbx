import type { NacosNamespaceInfo } from "@/types/nacos";

/**
 * Nacos 2/r-nacos may represent the default namespace with an empty ID, while
 * Nacos 3 returns the concrete `public` ID. Older backend builds could expose
 * both forms at once; prefer the concrete ID and keep every other namespace.
 */
export function normalizeNacosNamespacesForDisplay(namespaces: NacosNamespaceInfo[]): NacosNamespaceInfo[] {
  const normalized = new Map<string, NacosNamespaceInfo>();
  for (const namespace of namespaces) {
    const identity = nacosNamespaceIdentity(namespace.namespace);
    const existing = normalized.get(identity);
    // Prefer the concrete public ID when both legacy representations are returned.
    if (!existing || (identity === "public" && namespace.namespace === "public" && existing.namespace === "")) {
      normalized.set(identity, namespace);
    }
  }
  return [...normalized.values()];
}

/** Returns the stable display/filter identity without changing the value sent to Nacos. */
export function nacosNamespaceIdentity(namespace: string): string {
  return namespace === "" || namespace === "public" ? "public" : namespace;
}

/** Converts selected identities back to the namespace IDs returned by this Nacos endpoint. */
export function normalizeNacosNamespaceSelection(selected: Iterable<string>, namespaces: NacosNamespaceInfo[]): string[] {
  const available = new Map<string, string>();
  for (const namespace of normalizeNacosNamespacesForDisplay(namespaces)) {
    available.set(nacosNamespaceIdentity(namespace.namespace), namespace.namespace);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of selected) {
    const identity = nacosNamespaceIdentity(value);
    const namespace = available.get(identity);
    if (namespace !== undefined && !seen.has(identity)) {
      seen.add(identity);
      result.push(namespace);
    }
  }
  return result;
}

/** `visible_databases` stores the namespace identifiers selected for a Nacos connection. */
export function filterNacosNamespacesForSidebar(namespaces: NacosNamespaceInfo[], visibleNamespaces: string[] | undefined): NacosNamespaceInfo[] {
  const normalized = normalizeNacosNamespacesForDisplay(namespaces);
  if (!Array.isArray(visibleNamespaces)) return normalized;
  const visible = new Set(visibleNamespaces.map(nacosNamespaceIdentity));
  return normalized.filter((namespace) => visible.has(nacosNamespaceIdentity(namespace.namespace)));
}
