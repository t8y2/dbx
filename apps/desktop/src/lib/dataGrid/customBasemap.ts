export interface CustomBasemapConfig {
  name: string;
  url: string;
  overlayUrl: string;
  attribution: string;
  maxZoom: number;
}

export const CUSTOM_BASEMAP_SESSION_KEY = "dbx-layer-preview-custom-basemap";
export const BASEMAP_SELECTION_SESSION_KEY = "dbx-layer-preview-selected-basemap";
export const DEFAULT_CUSTOM_BASEMAP_NAME = "Custom basemap";

const BASEMAP_ID_PATTERN = /^[a-z0-9-]{1,50}$/;

export function escapeCustomBasemapAttribution(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function isValidTileUrlTemplate(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return false;
  return ["{z}", "{x}", "{y}"].every((token) => trimmed.includes(token));
}

export function normalizeCustomBasemapConfig(value: unknown): CustomBasemapConfig | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CustomBasemapConfig>;
  const name = typeof candidate.name === "string" ? candidate.name.trim().slice(0, 50) : "";
  const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
  const overlayUrl = typeof candidate.overlayUrl === "string" ? candidate.overlayUrl.trim() : "";
  const attribution = typeof candidate.attribution === "string" ? candidate.attribution.trim() : "";
  const maxZoom = typeof candidate.maxZoom === "number" && Number.isFinite(candidate.maxZoom) ? Math.round(candidate.maxZoom) : 18;
  if (!name || !isValidTileUrlTemplate(url) || (overlayUrl && !isValidTileUrlTemplate(overlayUrl))) return null;
  return {
    name,
    url,
    overlayUrl,
    attribution,
    maxZoom: Math.min(24, Math.max(1, maxZoom)),
  };
}

export function loadCustomBasemapConfig(storage: Pick<Storage, "getItem"> | null | undefined): CustomBasemapConfig | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CUSTOM_BASEMAP_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !("name" in parsed)) parsed.name = DEFAULT_CUSTOM_BASEMAP_NAME;
    return normalizeCustomBasemapConfig(parsed);
  } catch {
    return null;
  }
}

export function saveCustomBasemapConfig(storage: Pick<Storage, "setItem"> | null | undefined, config: CustomBasemapConfig): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CUSTOM_BASEMAP_SESSION_KEY, JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
}

export function loadSelectedBasemapId(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    const id = storage.getItem(BASEMAP_SELECTION_SESSION_KEY);
    return id && BASEMAP_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function saveSelectedBasemapId(storage: Pick<Storage, "setItem"> | null | undefined, id: string): boolean {
  if (!storage || !BASEMAP_ID_PATTERN.test(id)) return false;
  try {
    storage.setItem(BASEMAP_SELECTION_SESSION_KEY, id);
    return true;
  } catch {
    return false;
  }
}

export function resolveSelectedBasemapId(selectedId: string | null, builtInIds: readonly string[], hasCustomBasemap: boolean): string | null {
  if (selectedId === "custom" && hasCustomBasemap) return selectedId;
  if (selectedId && builtInIds.includes(selectedId)) return selectedId;
  return builtInIds[0] ?? null;
}
