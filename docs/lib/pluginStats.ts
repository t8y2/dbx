import type { DocsLang } from "@/lib/i18n";

// Display counters for marketplace cards. Absolute URL so local dev/preview
// also hits the live endpoint (it answers with permissive CORS); only the
// public installs number is exposed — dl/updt and unique counts stay internal.
export const PLUGIN_STATS_URL = "https://dbxio.com/api/plugins/stats";

const PLUGIN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export type PluginInstalls = Record<string, number>;

// Failure is decorative, not fatal: cards simply render without a count.
export async function fetchPluginInstalls(init?: RequestInit): Promise<PluginInstalls | null> {
  try {
    const response = await fetch(PLUGIN_STATS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
      ...init,
    });
    if (!response.ok) throw new Error(`Plugin stats request failed with ${response.status}`);
    const payload = (await response.json()) as { installs?: unknown };
    if (typeof payload !== "object" || payload === null || typeof payload.installs !== "object" || payload.installs === null) {
      throw new Error("Plugin stats payload malformed");
    }
    const installs: PluginInstalls = {};
    for (const [id, value] of Object.entries(payload.installs as Record<string, unknown>)) {
      if (PLUGIN_ID_PATTERN.test(id) && typeof value === "number" && Number.isFinite(value) && value > 0) installs[id] = value;
    }
    return installs;
  } catch {
    return null;
  }
}

export function formatPluginInstalls(count: number, lang: DocsLang): string {
  return new Intl.NumberFormat(lang === "cn" ? "zh-CN" : "en-US").format(count);
}
