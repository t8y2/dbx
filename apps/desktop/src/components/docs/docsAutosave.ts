import { ref, type Ref } from "vue";
import type { AnnotationFile } from "@/docs/types";

export type SaveStatus = { state: "idle" } | { state: "saving" } | { state: "saved" } | { state: "failed"; message: string };

export interface Autosave {
  schedule: (file: AnnotationFile) => void;
  flush: () => Promise<void>;
  status: Ref<SaveStatus>;
}

/**
 * Debounced autosave.
 *
 * A failed write MUST become visible: the user keeps typing and believes
 * their notes are saved otherwise. The pending file is retained on failure so
 * the next edit retries rather than discarding what they wrote.
 */
export function createAutosave(save: (file: AnnotationFile) => Promise<void>, delayMs: number): Autosave {
  const status = ref<SaveStatus>({ state: "idle" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AnnotationFile | undefined;
  // The write currently in flight, if any. `flush()` clearing the timer is not
  // enough: a debounced write may already be awaiting `save`, and starting a
  // second one issues two concurrent saves of the same file. Beyond wasting a
  // round trip, the later one can land stale, and it is the exact concurrency
  // that corrupted the notes file before the Rust side used a unique temp path.
  let inFlight: Promise<void> | undefined;

  async function write(): Promise<void> {
    if (inFlight !== undefined) {
      // Wait for the current write, then run again if an edit arrived while it
      // was going — never two at once.
      await inFlight;
      if (pending === undefined) {
        return;
      }
    }
    if (pending === undefined) {
      return;
    }
    const file = pending;
    status.value = { state: "saving" };
    const attempt = (async () => {
      try {
        await save(file);
        // Only clear if no newer edit arrived while this was in flight.
        if (pending === file) {
          pending = undefined;
        }
        status.value = { state: "saved" };
      } catch (error) {
        status.value = { state: "failed", message: error instanceof Error ? error.message : String(error) };
      }
    })();
    inFlight = attempt;
    try {
      await attempt;
    } finally {
      if (inFlight === attempt) {
        inFlight = undefined;
      }
    }
  }

  return {
    status,
    schedule(file) {
      pending = file;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => void write(), delayMs);
    },
    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await write();
    },
  };
}
