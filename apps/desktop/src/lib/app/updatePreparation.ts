import { onScopeDispose } from "vue";
import i18n from "@/i18n";
import { uuid } from "@/lib/common/utils";

const blockers = new Set<() => string | undefined>();
let barrierDepth = 0;
export const UPDATE_RESTORE_KEY = "dbx-update-restore-tabs";

/** Why the installer was held back — a block never installs anything. */
export type UpdatePreparationBlockCode = "not_ready" | "tasks" | "drafts" | "config" | "config_busy" | "window_operation" | "busy" | "cancelled" | "timeout" | "windows_changed";

/**
 * Safety refusals are not installation failures: the caller must present them as
 * "update not started, close X" instead of "update installation failed".
 */
export class UpdatePreparationError extends Error {
  readonly code: UpdatePreparationBlockCode;

  constructor(message: string, code: UpdatePreparationBlockCode = "not_ready") {
    super(message);
    this.name = "UpdatePreparationError";
    this.code = code;
  }
}

export function isUpdatePreparationError(error: unknown): error is UpdatePreparationError {
  return error instanceof UpdatePreparationError;
}

/** Editors with non-durable drafts must explicitly veto a restart. */
export function useUpdateBlocker(blocker: () => string | undefined): void {
  blockers.add(blocker);
  onScopeDispose(() => blockers.delete(blocker));
}

/** Reserve a window/task transition before its first asynchronous boundary. */
export function beginUpdateSensitiveOperation(reason?: string): () => void {
  assertUpdateAllowsInteraction();
  const blocker = () => reason ?? i18n.global.t("updates.preparationWindowOperation");
  blockers.add(blocker);
  return () => {
    blockers.delete(blocker);
  };
}

export function assertUpdateSafe(): void {
  for (const blocker of blockers) {
    const reason = blocker();
    if (reason) throw new Error(reason);
  }
}

// While the barrier is up the installer/relauncher may kill the process, so only
// the updater handoff and the durable-draft writes issued by the preparation
// persist() callback are allowed. Everything else is rejected fail-closed.
const PREPARATION_ALLOWED_COMMANDS = new Set([
  "save_open_tabs_state",
  "save_detached_tab_handoff",
  "load_detached_tab_handoff",
  "save_tab_result_snapshot",
  // Draft flush: default-query content, its optional directory mirror, and the
  // saved-SQL editor positions queued by the same persist pass.
  "save_default_query_content",
  "save_saved_sql_editor_positions",
  "sync_saved_sql_directory",
  "load_saved_sql_files_for_sync",
  "get_downloaded_update",
  "install_downloaded_update",
  "discard_downloaded_update",
  // The macOS/Linux restart is a frontend command invoked after preparation
  // succeeds, while the barrier is intentionally still held.
  "relaunch_app",
]);

export function assertUpdateAllowsCommand(command: string): void {
  if (!barrierDepth) return;
  if (!PREPARATION_ALLOWED_COMMANDS.has(command)) throw new Error("Update preparation is in progress. Please wait.");
}

export function isUpdatePreparationActive(): boolean {
  return barrierDepth > 0;
}

export function assertUpdateAllowsInteraction(): void {
  if (barrierDepth) throw new Error("Update preparation is in progress. Please wait.");
}

// Register during module evaluation, before App mounts its capture-phase shortcuts.
// Registering only at installation time would let older listeners run first.
const inputEvents = ["keydown", "keyup", "pointerdown", "mousedown", "click", "dblclick", "beforeinput", "paste", "cut", "drop", "contextmenu"];
const stopDuringPreparation = (event: Event) => {
  if (!barrierDepth) return;
  event.preventDefault();
  event.stopImmediatePropagation();
};
if (typeof window !== "undefined" && window.addEventListener) {
  for (const event of inputEvents) window.addEventListener(event, stopDuringPreparation, true);
}

export function acquireUpdateBarrier(): () => void {
  barrierDepth++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    barrierDepth--;
  };
}

/** Mark only fully prepared attempts; retain recovery if install succeeds but relaunch fails. */
export async function prepareUpdateWithDraftRecovery(prepare: () => Promise<() => void>, storage: Pick<Storage, "setItem"> = window.localStorage): Promise<() => void> {
  const release = await prepare();
  try {
    storage.setItem(UPDATE_RESTORE_KEY, "1");
  } catch (error) {
    release();
    throw error;
  }
  // The release callback does not know whether native installation succeeded.
  // Conservatively keep drafts recoverable after any fully prepared attempt.
  return release;
}

export interface UpdatePreparationParticipant {
  assertSafe(): void;
  persist(): Promise<void>;
  translate?(key: string): string;
}

/** ACK every live webview before the installer can terminate the process. */
export async function setupUpdatePreparation(participant: UpdatePreparationParticipant): Promise<{ prepare(): Promise<() => void>; dispose(): void }> {
  const { listen, emit, emitTo } = await import("@tauri-apps/api/event");
  const { getAllWebviewWindows, getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const label = getCurrentWebviewWindow().label;
  const message = (key: string, fallback: string) => participant.translate?.(`updates.${key}`) ?? fallback;
  const held = new Map<string, () => void>();
  const released = new Set<string>();
  const pending = new Map<string, (payload: { label: string; error?: string; code?: UpdatePreparationBlockCode }) => void>();
  const prepareLocal = async (id: string) => {
    if (released.has(id)) throw new UpdatePreparationError(message("preparationCancelled", "Update preparation was cancelled"), "cancelled");
    if (held.has(id)) throw new UpdatePreparationError(message("preparationBusy", "Update preparation already in progress"), "busy");
    held.set(id, acquireUpdateBarrier());
    participant.assertSafe();
    assertUpdateSafe();
    await participant.persist();
    participant.assertSafe();
    assertUpdateSafe();
  };
  const release = (id: string) => {
    released.add(id);
    held.get(id)?.();
    held.delete(id);
  };
  const unlisteners = [
    await listen<{ id: string; owner: string }>("dbx:update-prepare", async ({ payload }) => {
      if (payload.owner === label) return;
      let error: string | undefined;
      let code: UpdatePreparationBlockCode | undefined;
      try {
        await prepareLocal(payload.id);
      } catch (cause) {
        // Only the message survives the webview hop, so carry the reason code too
        // and keep the text free of the "Error: " prefix String(cause) produced.
        error = cause instanceof Error ? cause.message : String(cause);
        code = isUpdatePreparationError(cause) ? cause.code : "not_ready";
        release(payload.id);
      }
      await emitTo(payload.owner, "dbx:update-prepared", { id: payload.id, label, error, code });
    }),
    await listen<{ id: string; label: string; error?: string; code?: UpdatePreparationBlockCode }>("dbx:update-prepared", ({ payload }) => pending.get(payload.id)?.(payload)),
    await listen<{ id: string }>("dbx:update-release", ({ payload }) => release(payload.id)),
  ];
  return {
    async prepare() {
      if (held.size) throw new UpdatePreparationError(message("preparationBusy", "Update preparation already in progress"), "busy");
      const id = uuid();
      const members = (await getAllWebviewWindows()).map((item) => item.label).sort();
      const expected = new Set(members.filter((item) => item !== label));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const acknowledgements = new Promise<void>((resolve, reject) => {
        pending.set(id, (payload) => {
          if (!expected.has(payload.label)) return;
          if (payload.error) {
            // The blocking dialog is usually not in this window, so say so once
            // instead of leaving the user staring at a window with nothing open.
            const hint = message("preparationOtherWindowHint", " (the dialog is in another DBX window)");
            reject(new UpdatePreparationError(`${payload.error}${hint}`, payload.code ?? "not_ready"));
            return;
          }
          expected.delete(payload.label);
          if (!expected.size) resolve();
        });
        if (!expected.size) resolve();
      });
      // Attach the rejection handler immediately while the local disk flush runs.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UpdatePreparationError(message("preparationTimeout", "A window did not save its drafts within 5 seconds. Please retry."), "timeout")), 5000);
      });
      const work = Promise.race([Promise.all([acknowledgements, prepareLocal(id), emit("dbx:update-prepare", { id, owner: label })]), timeout]);
      try {
        await work;
        const current = (await getAllWebviewWindows()).map((item) => item.label).sort();
        if (JSON.stringify(current) !== JSON.stringify(members)) throw new UpdatePreparationError(message("preparationWindowsChanged", "Open windows changed during update preparation. Please retry."), "windows_changed");
        participant.assertSafe();
        assertUpdateSafe();
        return () => {
          release(id);
          void emit("dbx:update-release", { id });
        };
      } catch (error) {
        release(id);
        await emit("dbx:update-release", { id });
        throw error;
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    },
    dispose() {
      unlisteners.forEach((unlisten) => unlisten());
      held.forEach((unlock) => unlock());
      held.clear();
    },
  };
}
