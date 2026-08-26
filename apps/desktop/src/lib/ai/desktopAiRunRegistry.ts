import { shallowReactive } from "vue";

export type DesktopAiRunStatus = "preparing" | "queued" | "running" | "awaiting_write_confirmation" | "completed" | "failed" | "cancelled" | "pending_recoverable";

export type DesktopAiRunFifoCategory = "normal_send" | "write_confirmation_resume";

const DESKTOP_AI_CONCURRENCY_LIMIT = 3;

export interface DesktopAiRunRuntime<TMessage = unknown> {
  runId: string;
  conversationId: string;
  sessionIds: string[];
  currentSessionId: string;
  status: DesktopAiRunStatus;
  messages: TMessage[];
  assistantMessageIndex: number;
  connectionId: string;
  connectionName: string;
  database: string;
  schema?: string;
  pendingConfirmation?: unknown;
  /** Queue category of a global-FIFO item, persisted so restart recovery can
   *  tell a normal send (→ editable pending input) from an accepted
   *  write-confirmation resume (→ back to awaiting confirmation). */
  fifoCategory?: DesktopAiRunFifoCategory;
  /** User input text carried by a normal-send FIFO item, recovered after
   *  restart as an editable, unsent pending draft. */
  pendingInput?: string;
  /** Highest event `seq` assigned to this run, across all its sessions (parent
   *  PRD §8). Strictly increasing from 1; persisted with the run. */
  maxSeq?: number;
  /** True when the user rejected the write-confirmation card for this run. A
   *  run cancelled on this path must NOT auto-send the conversation's queued
   *  input (parent PRD §5). In-memory only — never serialized. */
  pendingConfirmationRejected?: boolean;
  createdAt: string;
  updatedAt: string;
  cancelRequested: boolean;
  discardOnFinish?: boolean;
  flushPending?: () => void;
  /** Resolved by the owning send() pipeline once it has fully settled (its
   *  finally block, or a pre-stream early return). A stop request waits on this
   *  signal rather than finalizing the run itself, so a cancellation-pending
   *  run stays visible - and keeps owning its concurrency slot - until the
   *  real terminal event (or a bounded force-abandon). Runtime-only - never
   *  serialized. */
  settled?: Promise<void>;
}

// This registry deliberately lives outside AiAssistant.vue. Closing the panel
// unmounts its view in some layouts, but a Desktop run remains addressable until
// it reaches a terminal state. Web never registers runs here.
const runsByConversation = shallowReactive(new Map<string, DesktopAiRunRuntime>());
const admittedRunIds = new Set<string>();
const admissionQueue: Array<{ run: DesktopAiRunRuntime; resolve: (admitted: boolean) => void }> = [];

export function registerDesktopAiRun<TMessage>(run: DesktopAiRunRuntime<TMessage>): DesktopAiRunRuntime<TMessage> {
  runsByConversation.set(run.conversationId, run as DesktopAiRunRuntime);
  return run;
}

export function desktopAiRun<TMessage = unknown>(conversationId: string): DesktopAiRunRuntime<TMessage> | undefined {
  return runsByConversation.get(conversationId) as DesktopAiRunRuntime<TMessage> | undefined;
}

export function updateDesktopAiRun(run: DesktopAiRunRuntime, patch: Partial<DesktopAiRunRuntime>): void {
  Object.assign(run, patch, { updatedAt: new Date().toISOString() });
  // Values are intentionally shallow (message arrays can be large). Re-setting
  // the entry invalidates count/badge computations when status changes.
  runsByConversation.set(run.conversationId, run);
}

export function finishDesktopAiRun(run: DesktopAiRunRuntime, status: Extract<DesktopAiRunStatus, "completed" | "failed" | "cancelled">): void {
  updateDesktopAiRun(run, { status, currentSessionId: "", flushPending: undefined, pendingConfirmation: undefined });
}

export function acquireDesktopAiRunSlot(run: DesktopAiRunRuntime): Promise<boolean> {
  if (admittedRunIds.has(run.runId)) return Promise.resolve(true);
  if (admittedRunIds.size < DESKTOP_AI_CONCURRENCY_LIMIT) {
    admittedRunIds.add(run.runId);
    return Promise.resolve(true);
  }
  updateDesktopAiRun(run, { status: "queued" });
  return new Promise((resolve) => admissionQueue.push({ run, resolve }));
}

export function releaseDesktopAiRunSlot(runId: string): void {
  if (!admittedRunIds.delete(runId)) return;
  while (admissionQueue.length > 0 && admittedRunIds.size < DESKTOP_AI_CONCURRENCY_LIMIT) {
    const next = admissionQueue.shift()!;
    if (next.run.cancelRequested || next.run.status === "cancelled") {
      next.resolve(false);
      continue;
    }
    admittedRunIds.add(next.run.runId);
    updateDesktopAiRun(next.run, { status: "preparing" });
    next.resolve(true);
  }
}

export function cancelQueuedDesktopAiRun(run: DesktopAiRunRuntime): boolean {
  const index = admissionQueue.findIndex((entry) => entry.run === run);
  if (index < 0) return false;
  const [entry] = admissionQueue.splice(index, 1);
  run.cancelRequested = true;
  finishDesktopAiRun(run, "cancelled");
  entry.resolve(false);
  return true;
}

export function activeDesktopAiRuns(): DesktopAiRunRuntime[] {
  return [...runsByConversation.values()].filter((run) => run.status === "preparing" || run.status === "queued" || run.status === "running" || run.status === "awaiting_write_confirmation");
}

/** Terminal statuses: the run has fully settled and no longer blocks the
 *  conversation, the quit prompt, or a concurrency slot. `interrupted` is a
 *  persisted-row-only pseudo status (never a runtime status) and is excluded
 *  here for that reason. */
export function isTerminalDesktopAiRunStatus(status: DesktopAiRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Statuses that block queue-send/auto-send: the conversation already owns a
 *  run the queued input must wait behind (parent PRD §5). */
export function hasActiveDesktopAiRun(conversationId: string): boolean {
  const run = runsByConversation.get(conversationId);
  if (!run) return false;
  return run.status === "preparing" || run.status === "queued" || run.status === "running" || run.status === "awaiting_write_confirmation" || run.status === "pending_recoverable";
}

export function blockingDesktopAiRunsForQuit(): DesktopAiRunRuntime[] {
  return [...runsByConversation.values()].filter((run) => run.status === "preparing" || run.status === "queued" || run.status === "running");
}

/**
 * Advances a run's event `seq` (parent PRD §8). Every agent event for the run —
 * across all its sessions — takes the next integer, strictly increasing from 1.
 * Returns the new seq so the caller can record it as the last-processed anchor.
 */
export function bumpDesktopAiRunSeq(run: DesktopAiRunRuntime): number {
  const next = (run.maxSeq ?? 0) + 1;
  run.maxSeq = next;
  runsByConversation.set(run.conversationId, run);
  return next;
}

export function removeDesktopAiRun(conversationId: string): void {
  runsByConversation.delete(conversationId);
}

export function retireDesktopAiRun(run: DesktopAiRunRuntime): void {
  if (runsByConversation.get(run.conversationId) === run) runsByConversation.delete(run.conversationId);
}

export function resetDesktopAiRunRegistryForTests(): void {
  runsByConversation.clear();
  admittedRunIds.clear();
  while (admissionQueue.length) admissionQueue.shift()!.resolve(false);
}
