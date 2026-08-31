import { describe, expect, it, vi } from "vitest";
import { createConnectionNoteVisibilityDraft, persistConnectionNoteVisibilityDraft, resetConnectionNoteVisibilityDraft, setConnectionNoteVisibilityDraft, syncConnectionNoteVisibilityDraft } from "../connectionNoteVisibilityDraft";

describe("connection note visibility draft", () => {
  it("follows external settings updates until the user changes the switch", () => {
    const draft = createConnectionNoteVisibilityDraft(false);

    syncConnectionNoteVisibilityDraft(draft, true);
    expect(draft).toEqual({ value: true, dirty: false });

    setConnectionNoteVisibilityDraft(draft, false);
    syncConnectionNoteVisibilityDraft(draft, true);
    expect(draft).toEqual({ value: false, dirty: true });
  });

  it("discards an unsaved switch change when the dialog closes", () => {
    const draft = createConnectionNoteVisibilityDraft(false);

    setConnectionNoteVisibilityDraft(draft, true);
    resetConnectionNoteVisibilityDraft(draft, false);

    expect(draft).toEqual({ value: false, dirty: false });
  });

  it("keeps the draft dirty after persistence fails so retry remains possible", async () => {
    const draft = createConnectionNoteVisibilityDraft(false);
    const persist = vi.fn().mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValueOnce(undefined);
    setConnectionNoteVisibilityDraft(draft, true);

    await expect(persistConnectionNoteVisibilityDraft(draft, false, persist)).rejects.toThrow("storage unavailable");
    expect(draft).toEqual({ value: true, dirty: true });

    await persistConnectionNoteVisibilityDraft(draft, false, persist);
    expect(draft).toEqual({ value: true, dirty: false });
    expect(persist).toHaveBeenCalledTimes(2);
  });
});
