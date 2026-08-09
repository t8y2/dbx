import type { PluginFilesystemEntry, PluginFilesystemProviderContribution } from "@/types/database";

export function pluginFilesystemRootUri(provider: Pick<PluginFilesystemProviderContribution, "root_uri" | "schemes">): string {
  return provider.root_uri || `${provider.schemes[0]}:/`;
}

export function pluginFilesystemParentUri(uri: string, root: string): string | undefined {
  if (!uri || uri === root) return undefined;
  const schemeEnd = uri.indexOf(":");
  if (schemeEnd < 1) return root;
  const minimumEnd = uri.startsWith("//", schemeEnd + 1)
    ? (() => {
        const authorityEnd = uri.indexOf("/", schemeEnd + 3);
        return authorityEnd < 0 ? uri.length : authorityEnd + 1;
      })()
    : schemeEnd + 2;
  const normalized = uri.endsWith("/") && uri.length > minimumEnd ? uri.slice(0, -1) : uri;
  const separator = normalized.lastIndexOf("/");
  const parent = separator < minimumEnd ? uri.slice(0, minimumEnd) : uri.slice(0, separator + 1);
  return parent.length < root.length ? root : parent;
}

export function sortPluginFilesystemEntries(entries: readonly PluginFilesystemEntry[]): PluginFilesystemEntry[] {
  return [...entries].sort((left, right) => {
    const leftDirectory = left.kind === "directory";
    const rightDirectory = right.kind === "directory";
    if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
}
