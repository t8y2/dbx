import { metadataLoadBudgetMs, waitForMetadata } from "@/lib/metadata/metadataLoadBudget";

export interface VisibleDatabasesPickerDraft {
  /** Opens the one-time draft connection the picker lists its objects from. */
  connect: () => Promise<unknown>;
  /** Reads the visible object names (databases or schemas) through that draft. */
  listNames: () => Promise<string[]>;
  /** Releases the draft connection; best-effort, it never blocks the dialog. */
  disconnect: () => Promise<void>;
  /** Effective query timeout of the draft, used to derive the local load budget. */
  queryTimeoutSecs?: number | undefined;
}

/**
 * Loads the names shown by the connection dialog's "visible objects" picker.
 *
 * Every step is bounded by the local metadata load budget, and releasing the draft
 * connection is best-effort. A server (or a proxy in front of it) that answers the
 * connection probe but stays silent for `CONFIG`/`INFO` used to leave the picker
 * spinning with the rest of the dialog disabled, because nothing along this path
 * cancelled the wait (#12426).
 */
export async function loadVisibleDatabasesPickerNames(draft: VisibleDatabasesPickerDraft): Promise<string[]> {
  const budgetMs = metadataLoadBudgetMs(draft.queryTimeoutSecs);
  try {
    await waitForMetadata(draft.connect(), budgetMs);
    return await waitForMetadata(draft.listNames(), budgetMs);
  } finally {
    try {
      void draft.disconnect().catch(() => undefined);
    } catch {
      // A synchronous teardown failure must not replace the load result.
    }
  }
}
