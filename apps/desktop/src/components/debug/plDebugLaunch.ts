import { ref } from "vue";
import i18n from "@/i18n";
import { useToast } from "@/composables/useToast";
import { usePlDebugStore } from "@/stores/plDebugStore";
import { resolvePlDebugAnonymousBlockText } from "@/lib/debug/plDebugAnonymousBlock";
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
  source?: string;
}

/** Target currently being prepared, or null when no launch is pending. */
export const plDebugLaunchTarget = ref<PlDebugLaunchTarget | null>(null);

/** Whether the "Debug PL/SQL" parameter dialog is open. */
export const plDebugLaunchOpen = ref(false);
export const plDebugRecoveryConnectionId = ref<string | null>(null);

export function openPlDebugRecovery(connectionId: string) {
  plDebugRecoveryConnectionId.value = connectionId;
}

export async function resolvePlDebugProbe(connectionId: string, database = ""): Promise<PlDebugProbeResult> {
  return usePlDebugStore().runProbe(connectionId, database);
}

function canOpenPlDebug(target: { connectionId: string; database: string; databaseType?: DatabaseType }): boolean {
  if (!supportsPlDebugRoutine(target.databaseType)) {
    useToast().toast(i18n.global.t("plDebug.launch.unsupported"), 5000);
    return false;
  }
  return !!target.connectionId && !!target.database;
}

/**
 * Opens the existing parameter dialog. Its fresh inspect response, selected
 * signature and explicit risk confirmation govern the eventual start.
 */
export async function launchPlDebug(target: PlDebugLaunchTarget): Promise<boolean> {
  if (!canOpenPlDebug(target)) return false;
  plDebugLaunchTarget.value = { ...target };
  plDebugLaunchOpen.value = true;
  return true;
}

/** An anonymous block handed to the debugger straight from the SQL editor. */
export interface PlDebugAnonymousLaunchTarget {
  connectionId: string;
  database: string;
  databaseType?: DatabaseType;
  schema?: string;
  /** Editor selection; wins over `documentText` when it is not blank. */
  selectedText: string;
  /** Full editor text, used when nothing is selected. */
  documentText: string;
}

/**
 * Opens the same confirmation dialog for a validated editor block, retaining
 * its original source and line numbers. No program executes before confirmation.
 */
export async function launchPlDebugAnonymous(target: PlDebugAnonymousLaunchTarget): Promise<boolean> {
  const resolved = resolvePlDebugAnonymousBlockText(target.selectedText, target.documentText);
  if (!resolved.ok) {
    useToast().toast(i18n.global.t(resolved.reason === "empty" ? "plDebug.launch.anonymousEmpty" : "plDebug.launch.anonymousInvalid"), 5000);
    return false;
  }
  return launchPlDebug({ connectionId: target.connectionId, database: target.database, databaseType: target.databaseType, schema: target.schema, objectType: "ANONYMOUS", objectName: "", source: resolved.source });
}
