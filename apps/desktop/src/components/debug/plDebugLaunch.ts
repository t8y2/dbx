import { ref } from "vue";
import i18n from "@/i18n";
import { useToast } from "@/composables/useToast";
import { usePlDebugStore } from "@/stores/plDebugStore";
import type { PlDebugProbeResult } from "@/lib/backend/pl-debug-tauri";
import type { DatabaseType } from "@/types/database";
import { supportsPlDebugRoutine } from "@/lib/database/databaseFeatureSupport";

/**
 * A routine the user asked to debug, before its parameters are loaded.
 *
 * `packageName` is set for package members: the agent then debugs
 * `<owner>.<package>.<routine>` and the parameter query has to narrow down to
 * that member instead of returning every routine of the package.
 */
export interface PlDebugLaunchTarget {
  connectionId: string;
  database: string;
  databaseType?: DatabaseType;
  schema?: string;
  /** PROCEDURE | FUNCTION */
  objectType: string;
  objectName: string;
  packageName?: string;
  /**
   * Object validity as the sidebar / object browser already know it.
   * `false` means the dictionary reports the routine as INVALID (Oracle
   * `USER_OBJECTS.STATUS`), which no debugger can attach to.
   */
  valid?: boolean | null;
}

/** Target currently being prepared, or null when no launch is pending. */
export const plDebugLaunchTarget = ref<PlDebugLaunchTarget | null>(null);

/** Whether the "Debug PL/SQL" parameter dialog is open. */
export const plDebugLaunchOpen = ref(false);

/**
 * Capability reports, keyed by connection id.
 *
 * The probe round-trips to the agent (dictionary lookups over DBMS_DEBUG /
 * DBMS_OUTPUT), so it must not run on every "Debug PL/SQL" click: one report per
 * connection is cached and reused, including by the variables panel, which reads
 * the same `store.probe` snapshot. A probe already in flight is shared as well,
 * so a double click cannot produce two identical round-trips.
 */
const probeCache = new Map<string, PlDebugProbeResult>();
const probeInflight = new Map<string, Promise<PlDebugProbeResult>>();

/** Monotonic id of the newest launch request; older ones must not open the dialog. */
let launchRequestId = 0;

/**
 * Resolves the connection's capability report, probing at most once per
 * connection. Exposed so the debug panel and the launch gate share one cache.
 */
export async function resolvePlDebugProbe(connectionId: string): Promise<PlDebugProbeResult> {
  const store = usePlDebugStore();
  const cached = probeCache.get(connectionId);
  if (cached) {
    // The variables panel reads `store.probe`, so the cached report has to be
    // published again rather than only returned.
    store.probe = cached;
    return cached;
  }
  const pending = probeInflight.get(connectionId);
  if (pending) return pending;
  const request = store
    .runProbe(connectionId)
    .then((result) => {
      probeCache.set(connectionId, result);
      return result;
    })
    .finally(() => {
      probeInflight.delete(connectionId);
    });
  probeInflight.set(connectionId, request);
  return request;
}

/**
 * Opens the PL/SQL debugger for a routine, after the two pre-flight checks the
 * backend capability report and the object's dictionary status allow.
 *
 * The launcher component loads the routine's parameters first, because the
 * dialog seeds its editable rows when it opens — so a target that cannot be
 * debugged must be rejected here, before the dialog appears:
 *   - `valid === false` (INVALID object) is refused outright;
 *   - `supported === false` (this server cannot be debugged) is refused and the
 *     agent's own `reason` is shown verbatim, never re-authored here;
 *   - `variablesSupported === false` with `supported === true` still launches:
 *     only variable inspection degrades, and the variables panel says so.
 *
 * Resolves true when the dialog was opened.
 */
export async function launchPlDebug(target: PlDebugLaunchTarget): Promise<boolean> {
  if (target.valid === false) {
    useToast().toast(i18n.global.t("plDebug.launch.invalidObject"), 5000);
    return false;
  }
  // Backstop for launchers that are not themselves behind
  // `supportsPlDebugRoutine` (the sidebar one is not): OceanBase Oracle Mode
  // ships a Java `pl_debug_*` implementation that has never been exercised
  // against a real instance, so its debugger stays unreachable through every
  // entry point until that verification exists.
  if (!supportsPlDebugRoutine(target.databaseType)) {
    useToast().toast(i18n.global.t("plDebug.launch.unsupported"), 5000);
    return false;
  }
  const requestId = ++launchRequestId;
  const probe = await resolvePlDebugProbe(target.connectionId);
  // A newer "Debug" click wins: this one must not reopen the dialog for a
  // target the user already moved away from.
  if (requestId !== launchRequestId) return false;
  if (probe.supported !== true) {
    // The backend's reason is the only accurate explanation (missing grants,
    // missing subroutines, …); it is displayed as written.
    useToast().toast(probe.reason || i18n.global.t("plDebug.launch.unsupported"), 5000);
    return false;
  }
  plDebugLaunchTarget.value = target;
  plDebugLaunchOpen.value = true;
  return true;
}
