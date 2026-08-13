import type { NacosConfigQuery, NacosNamespaceInfo } from "@/types/nacos";

const NACOS_NAMESPACE_ACCESS_PROBE_CONCURRENCY = 4;

function nacosNamespaceAccessErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    for (const key of ["message", "detail", "reason"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
    }
  }
  return String(error);
}

/** Only a namespace-level authorization denial is safe to turn into a hidden namespace. */
export function isNacosNamespaceAccessDenied(error: unknown): boolean {
  const message = nacosNamespaceAccessErrorMessage(error);
  if (!message.includes("NACOS_ERROR[authFailed]")) return false;
  return /\b403\b|forbidden|authorization\s+failed/i.test(message);
}

/**
 * Namespace list endpoints can disclose every namespace even when the current
 * user cannot read them. Probe the smallest config page and retain only the
 * namespaces the connection can actually open in the DBX workspace.
 */
export async function filterReadableNacosNamespaces(namespaces: NacosNamespaceInfo[], probe: (namespace: string) => Promise<unknown>, maxConcurrency = NACOS_NAMESPACE_ACCESS_PROBE_CONCURRENCY): Promise<NacosNamespaceInfo[]> {
  if (namespaces.length === 0) return [];

  const readable = Array.from({ length: namespaces.length }, () => false);
  let nextIndex = 0;
  const workerCount = Math.min(namespaces.length, Math.max(1, Math.floor(maxConcurrency)));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < namespaces.length) {
      const index = nextIndex++;
      try {
        await probe(namespaces[index]!.namespace);
        readable[index] = true;
      } catch (error) {
        if (!isNacosNamespaceAccessDenied(error)) throw error;
      }
    }
  });
  await Promise.all(workers);
  return namespaces.filter((_, index) => readable[index]);
}

type NacosNamespaceAccessClient = {
  nacosListNamespaces(connectionId: string): Promise<NacosNamespaceInfo[]>;
  nacosListConfigs(connectionId: string, query: NacosConfigQuery): Promise<unknown>;
};

/** Loads the normalized namespace list and applies the current connection's read access. */
export async function loadReadableNacosNamespaces(connectionId: string, client: NacosNamespaceAccessClient): Promise<NacosNamespaceInfo[]> {
  const listed = normalizeNacosNamespacesForDisplay(await client.nacosListNamespaces(connectionId));
  return filterReadableNacosNamespaces(listed, (namespace) => client.nacosListConfigs(connectionId, { namespace, pageNo: 1, pageSize: 1 }));
}

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
