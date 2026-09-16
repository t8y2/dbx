import { onScopeDispose } from "vue";
import i18n from "@/i18n";

const blockers = new Set<() => string | undefined>();
let barrierDepth = 0;
export const UPDATE_RESTORE_KEY = "dbx-update-restore-tabs";

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

export function assertUpdateAllowsCommand(command: string): void {
  if (!barrierDepth) return;
  // During the short install barrier only updater and durable-draft I/O are allowed.
  const allowed = new Set(["save_open_tabs_state", "save_detached_tab_handoff", "load_detached_tab_handoff", "save_tab_result_snapshot", "get_downloaded_update", "install_downloaded_update", "discard_downloaded_update"]);
  if (!allowed.has(command)) throw new Error("Update preparation is in progress. Please wait.");
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
  const pending = new Map<string, (payload: { label: string; error?: string }) => void>();
  const prepareLocal = async (id: string) => {
    if (released.has(id)) throw new Error(message("preparationCancelled", "Update preparation was cancelled"));
    if (held.has(id)) throw new Error(message("preparationBusy", "Update preparation already in progress"));
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
      try {
        await prepareLocal(payload.id);
      } catch (cause) {
        error = String(cause);
        release(payload.id);
      }
      await emitTo(payload.owner, "dbx:update-prepared", { id: payload.id, label, error });
    }),
    await listen<{ id: string; label: string; error?: string }>("dbx:update-prepared", ({ payload }) => pending.get(payload.id)?.(payload)),
    await listen<{ id: string }>("dbx:update-release", ({ payload }) => release(payload.id)),
  ];
  return {
    async prepare() {
      if (held.size) throw new Error(message("preparationBusy", "Update preparation already in progress"));
      const id = crypto.randomUUID();
      const members = (await getAllWebviewWindows()).map((item) => item.label).sort();
      const expected = new Set(members.filter((item) => item !== label));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const acknowledgements = new Promise<void>((resolve, reject) => {
        pending.set(id, (payload) => {
          if (!expected.has(payload.label)) return;
          if (payload.error) {
            reject(new Error(payload.error));
            return;
          }
          expected.delete(payload.label);
          if (!expected.size) resolve();
        });
        if (!expected.size) resolve();
      });
      // Attach the rejection handler immediately while the local disk flush runs.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message("preparationTimeout", "A window did not save its drafts within 5 seconds. Please retry."))), 5000);
      });
      const work = Promise.race([Promise.all([acknowledgements, prepareLocal(id), emit("dbx:update-prepare", { id, owner: label })]), timeout]);
      try {
        await work;
        const current = (await getAllWebviewWindows()).map((item) => item.label).sort();
        if (JSON.stringify(current) !== JSON.stringify(members)) throw new Error(message("preparationWindowsChanged", "Open windows changed during update preparation. Please retry."));
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
