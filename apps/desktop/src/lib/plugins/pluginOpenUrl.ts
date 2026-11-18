const PREFIX = "host.openUrl:";
export const MAX_PLUGIN_OPEN_URL_ORIGINS = 8;
export const MAX_PLUGIN_OPEN_URL_CHARS = 4096;

export function pluginOpenUrlOrigins(permissions: readonly string[] = []): string[] {
  const origins = new Set<string>();
  for (const permission of permissions) {
    if (!permission.startsWith(PREFIX)) continue;
    const origin = permission.slice(PREFIX.length);
    try {
      const url = new URL(origin);
      if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === origin && !url.username && !url.password && !origin.includes("*") && !/[\s\\]/.test(origin)) origins.add(origin);
    } catch {
      /* Invalid declarations never grant access. */
    }
    if (origins.size >= MAX_PLUGIN_OPEN_URL_ORIGINS) break;
  }
  return [...origins];
}

export function permittedPluginUrl(value: unknown, permissions?: readonly string[]): string {
  if (typeof value !== "string" || !value || value.length > MAX_PLUGIN_OPEN_URL_CHARS || [...value].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f || char === "\\")) throw new Error("Invalid plugin URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid plugin URL");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new Error("Only HTTP(S) URLs without credentials are allowed");
  if (!pluginOpenUrlOrigins(permissions).includes(url.origin)) throw new Error("Plugin URL origin is not declared in host.openUrl permissions");
  return url.href;
}
