import { ref } from "vue";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

const PROMOTED_BUILD_STORAGE_KEY = "dbx:promoted-build";

/**
 * A beta that is promoted to stable is not rebuilt, so the installed binary
 * keeps its `X.Y.Z-beta.YYYYMMDD.N` version even though that exact build is now
 * the stable `X.Y.Z` release. The stable manifest names the build it was
 * promoted from (`promoted_from`); once an update check sees that name equal to
 * the running build, the build is remembered here so the UI can show the stable
 * version. It is keyed by the full build version, so upgrading naturally
 * invalidates it.
 */
const promotedBuild = ref(normalizeBuildVersion(safeLocalStorageGet(PROMOTED_BUILD_STORAGE_KEY) ?? ""));

function normalizeBuildVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/**
 * Hands the promoted build to the backend, which renders the native macOS About
 * panel. localStorage alone is not enough: that panel is built in Rust before
 * the webview runs any update check, and macOS WebViews may drop localStorage
 * between restarts.
 */
function publishPromotedBuild(): void {
  if (!promotedBuild.value || !isTauriRuntime()) return;
  void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_promoted_build", { buildVersion: promotedBuild.value })).catch((error) => console.warn("[DBX][promoted-build:sync]", error));
}

export function recordPromotedBuild(info: { current_version: string; promoted_from?: string | null }): void {
  const promotedFrom = normalizeBuildVersion(info.promoted_from ?? "");
  if (!promotedFrom || promotedFrom !== normalizeBuildVersion(info.current_version)) return;
  if (promotedBuild.value === promotedFrom) return;
  promotedBuild.value = promotedFrom;
  safeLocalStorageSet(PROMOTED_BUILD_STORAGE_KEY, promotedFrom);
  publishPromotedBuild();
}

/**
 * Version to show users. A build recognised as promoted shows its stable
 * version; everything else, including diagnostics that need the real build,
 * keeps using the raw version.
 */
export function displayAppVersion(buildVersion: string): string {
  const build = normalizeBuildVersion(buildVersion);
  if (!build || build !== promotedBuild.value) return buildVersion;
  return build.split(/[-+]/, 1)[0];
}

// Re-report the remembered build once at startup: the backend may have lost it
// (fresh data directory, cleared app state) while localStorage still has it.
if (promotedBuild.value) publishPromotedBuild();
