import { AGENT_ACTIONS, ASK_ACTIONS, defaultActionForMode, isValidActionForMode, type AiAction, type AiActionSelection } from "@/lib/ai/ai";
import type { AiAssistantMode } from "@/types/ai";

/**
 * Per-conversation picker selection (Ask/Agent mode + action) — issue #12075.
 *
 * The picker used to be panel-level Vue refs only, so switching conversations
 * carried one chat's choice into another, and reopening a conversation always
 * fell back to the settings default. This module owns the whole rule set for
 *
 *   (persisted conversation record | unsaved-chat key, ambient capabilities)
 *     → { raw, effective }
 *
 * and is deliberately free of Vue, stores and DOM so the rules are unit-tested
 * directly (`__tests__/aiConversationPicker.spec.ts`), matching the #9902
 * pattern of `aiConversationBinding.ts`.
 *
 * Two layers, never merged (R9):
 *
 * - `raw` — the persisted original selection. Written ONLY when the user
 *   operates the picker (or an entry point that explicitly asks for a mode /
 *   action). A capability limit, a degradation and a fallback NEVER write back.
 * - `effective` — what is displayed and used for the next send. Always a legal
 *   combination.
 */

/**
 * The loose persisted shape. The columns are plain strings on purpose: a future
 * mode or action must not need a migration, so unknown values are validated
 * here instead of being rejected at the storage boundary.
 */
export interface AiPickerConversationRecord {
  /** `AiConversation.assistantMode` (columns added for #12075). */
  assistantMode?: string;
  /** `AiConversation.assistantAction`. */
  assistantAction?: string;
  /** Legacy fallback source for plugin conversations (R10 read priority). */
  pluginContextMode?: string;
}

/** The environment the selection has to be legal in. */
export interface AiPickerAmbient {
  /** `settings.defaultAiMode` — also the new-chat start mode. */
  defaultMode: AiAssistantMode;
  /** `settings.defaultAutoRouting` — the Settings > AI "Auto" toggle (#9118). */
  defaultAutoRouting: boolean;
  /** Vector-DB connection: the action menu is hidden and `generate` is forced. */
  vectorDb?: boolean;
  /**
   * A plugin conversation: the action menu is hidden and the action is locked to
   * `general` (the plugin lane always sends `general`). Set only on the restore /
   * background paths — the existing "pick a mode default" call sites
   * (mode switch, panel mount, new chat) must keep returning the Auto entry when
   * the toggle says so.
   */
  pluginSession?: boolean;
  /** A plugin conversation with no resolvable connection: mode degrades to `ask`. */
  pluginWithoutConnection?: boolean;
}

/** Persisted original selection; each field is absent until the user picks it. */
export interface AiPickerRaw {
  mode?: AiAssistantMode;
  action?: AiActionSelection;
}

/** Displayed / next-send selection. Always legal. */
export interface AiPickerSelection {
  mode: AiAssistantMode;
  action: AiActionSelection;
}

export interface AiPickerResolution {
  raw: AiPickerRaw;
  effective: AiPickerSelection;
}

/**
 * Every selectable picker entry. Derived from the mode tables so a new action
 * joins the known set automatically, and `auto` is added explicitly: it is a
 * valid picker entry in *every* mode and `isValidActionForMode` deliberately
 * does not know it (it must never reach the send path, #9118).
 */
const KNOWN_SELECTIONS: readonly string[] = [...ASK_ACTIONS, ...AGENT_ACTIONS, "auto"];

function knownMode(value: string | undefined | null): AiAssistantMode | undefined {
  return value === "ask" || value === "agent" ? value : undefined;
}

function knownSelection(value: string | undefined | null): AiActionSelection | undefined {
  return value && KNOWN_SELECTIONS.includes(value) ? (value as AiActionSelection) : undefined;
}

/**
 * Whether `selection` may be used in `mode`. `auto` is legal everywhere and is
 * checked first: `isValidActionForMode` only knows concrete actions.
 */
export function isPickerSelectionValidForMode(selection: AiActionSelection, mode: AiAssistantMode): boolean {
  if (selection === "auto") return true;
  return isValidActionForMode(selection, mode);
}

/**
 * The "land on the default" selection for `mode`: the mode's concrete action, or
 * the `auto` entry when the Settings > AI toggle asks for it.
 *
 * Used by every site that starts from a default — a new chat, a mode switch, the
 * panel-mount init (#9118) — and by R9's "unknown action" fallback.
 */
export function resolveDefaultPickerSelection(mode: AiAssistantMode, ambient: AiPickerAmbient): AiActionSelection {
  if (ambient.pluginSession) return "general";
  if (ambient.vectorDb) return "generate";
  return ambient.defaultAutoRouting ? "auto" : defaultActionForMode(mode);
}

/**
 * The concrete default action for `mode` — never `auto`, because the callers
 * (confirmed-write continuations, request assembly) must not hand a sentinel to
 * the transport. Also R9's "known but incompatible action" fallback: an action
 * that does not exist in the current mode lands on that mode's own default
 * instead of dragging the mode along.
 */
export function resolveDefaultPickerAction(mode: AiAssistantMode, ambient: AiPickerAmbient): AiAction {
  if (ambient.pluginSession) return "general";
  if (ambient.vectorDb) return "generate";
  return defaultActionForMode(mode);
}

/**
 * Replay a conversation's own picker state, with the R9 decision table applied:
 *
 * | case | effective | written back to raw |
 * |---|---|---|
 * | valid value | equals raw | — |
 * | unknown mode (absent, or an old record) | `ambient.defaultMode` | no |
 * | unknown action (absent, or an old record) | `resolveDefaultPickerSelection` | no |
 * | known action, incompatible with the mode | the mode's own default | no |
 * | capability limit (vector DB / plugin session) | the constrained value | no |
 *
 * Reading priority is R10's: `assistant_mode` → `pluginContext.mode` →
 * `settings.defaultAiMode`. A capability limit is applied last and touches
 * `effective` only, so a conversation keeps the user's original pick and gets it
 * back once the restriction is lifted (relational connection, connected plugin).
 */
export function resolveConversationPicker(record: AiPickerConversationRecord, ambient: AiPickerAmbient): AiPickerResolution {
  const rawMode = knownMode(record.assistantMode);
  const rawAction = knownSelection(record.assistantAction);
  const mode = rawMode ?? knownMode(record.pluginContextMode) ?? ambient.defaultMode;

  // Both fallbacks are guaranteed legal by construction, so the chain needs no
  // second validation pass (R9): the default selection is either `auto`, which
  // every mode accepts, or the mode's own default action.
  const action: AiActionSelection = rawAction ? (isPickerSelectionValidForMode(rawAction, mode) ? rawAction : resolveDefaultPickerAction(mode, ambient)) : resolveDefaultPickerSelection(mode, ambient);

  return {
    raw: { mode: rawMode, action: rawAction },
    effective: applyCapabilities({ mode, action }, ambient),
  };
}

/**
 * The capability limits of R5, applied to `effective` only.
 *
 * - Vector DB: the action picker is hidden, so the action stays `generate`.
 * - Plugin conversation: the composer hides the action menu and the plugin lane
 *   always sends `general`; with no resolvable connection Agent is unreachable,
 *   so the mode degrades to `ask`.
 *
 * `raw` is untouched by design: both restrictions are environmental, and the
 * user's own choice must come back when the environment changes.
 */
export function applyCapabilities(selection: AiPickerSelection, ambient: AiPickerAmbient): AiPickerSelection {
  let mode = selection.mode;
  let action = selection.action;
  if (ambient.vectorDb) action = "generate";
  if (ambient.pluginSession) {
    action = "general";
    if (ambient.pluginWithoutConnection) mode = "ask";
  }
  return { mode, action };
}
