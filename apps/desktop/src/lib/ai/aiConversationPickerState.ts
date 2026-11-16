import { ref, watch, type Ref } from "vue";
import type { AiAssistantMode } from "@/types/ai";
import type { AiActionSelection } from "@/lib/ai/ai";
import { applyCapabilities, resolveDefaultPickerSelection, type AiPickerAmbient, type AiPickerSelection } from "@/lib/ai/aiConversationPicker";

/**
 * The AI panel's Ask/Agent mode + action picker, owned as a pair (#12075).
 *
 * Before this existed the two values were independent panel-level refs and a
 * `watch(mode)` reset the action, so restoring a conversation's own selection
 * raced the reset: `assistantMode.value = stored; activeAction.value = stored`
 * looked right until the watcher flushed and overwrote the action with the mode
 * default. That is why the reset lives *inside* this controller now — a single
 * writer of the pair, which makes the restore order structurally correct instead
 * of relying on a flag each call site has to remember.
 *
 * Nothing here is persisted; `raw` belongs to the conversation record
 * (`AiConversation.assistantMode` / `assistantAction`) and is only written by
 * `onUserSelection`, which callers use to store a genuine picker operation (R9).
 */
export interface AiConversationPickerControllerOptions {
  /** Ambient capabilities, read lazily so a settings/connection change is picked
   *  up without rebuilding the controller. */
  ambient: () => AiPickerAmbient;
  /**
   * Called ONLY for a user picker operation, with the pair the user actually
   * chose (before capability limits). The caller records it as the
   * conversation's own `raw` selection; a restore, a capability limit and a
   * routed/external set never reach this hook (R9's "no write-back" rule).
   */
  onUserSelection?: (selection: AiPickerSelection) => void;
}

export interface AiConversationPickerController {
  /** Effective mode — what the picker shows and the next send uses. */
  mode: Ref<AiAssistantMode>;
  /** Effective action; always a legal entry for `mode` (incl. `auto`). */
  action: Ref<AiActionSelection>;
  /** Restore a conversation's own effective pair (R2), capabilities included. */
  restore(selection: AiPickerSelection): void;
  /** New chat / panel mount: the settings default mode and its default entry.
   *  Unchanged by #12075 (R3) — `defaultAutoRouting` still decides the entry. */
  restoreDefault(): AiPickerSelection;
  /** User picked a mode tab: lands on that mode's default entry and records it. */
  selectMode(mode: AiAssistantMode): AiPickerSelection;
  /** User picked an action entry (incl. `auto`) — recorded (R8/R9). */
  selectAction(action: AiActionSelection): AiPickerSelection;
  /** User picked an explicit mode+action pair (the "Auto · <action>" chip, which
   *  switches the picker onto the action that ran; the plugin request) — recorded. */
  select(selection: AiPickerSelection): AiPickerSelection;
}

export function createAiConversationPickerController(options: AiConversationPickerControllerOptions): AiConversationPickerController {
  const ambient = options.ambient;
  const mode = ref<AiAssistantMode>(ambient().defaultMode);
  const action = ref<AiActionSelection>("general");

  // Ownership handshake. `sync` flush is deliberate: the flag is consumed by the
  // very assignment that changes the mode, so a pair write can never poison a
  // later, unrelated mode change (the failure mode a pre-flush flag has — the
  // watcher has not run yet when the next writer looks at it).
  let ownedModeChange = false;
  watch(
    mode,
    (next) => {
      if (ownedModeChange) {
        ownedModeChange = false;
        return;
      }
      action.value = resolveDefaultPickerSelection(next, ambient());
    },
    { flush: "sync" },
  );

  /**
   * The only writer of the pair. `recorded` is the pair the user chose, before
   * capability limits: `effective` may be constrained (a vector DB must stay on
   * `generate`), while the recorded value stays the user's own (R9/R10).
   */
  function setPair(desired: AiPickerSelection, recorded?: AiPickerSelection) {
    const effective = applyCapabilities(desired, ambient());
    if (mode.value !== effective.mode) ownedModeChange = true;
    mode.value = effective.mode;
    action.value = effective.action;
    if (recorded) options.onUserSelection?.(recorded);
  }

  return {
    mode,
    action,
    restore(selection) {
      setPair(selection);
    },
    restoreDefault() {
      const next = { mode: ambient().defaultMode, action: resolveDefaultPickerSelection(ambient().defaultMode, ambient()) };
      setPair(next);
      return next;
    },
    selectMode(nextMode) {
      const desired = { mode: nextMode, action: resolveDefaultPickerSelection(nextMode, ambient()) };
      setPair(desired, desired);
      return desired;
    },
    selectAction(nextAction) {
      const desired = { mode: mode.value, action: nextAction };
      setPair(desired, desired);
      return desired;
    },
    select(selection) {
      setPair(selection, selection);
      return selection;
    },
  };
}
