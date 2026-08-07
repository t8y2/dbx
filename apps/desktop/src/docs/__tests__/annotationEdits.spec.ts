import { describe, expect, it } from "vitest";
import { emptyAnnotations, removeGroup, setColumnNote, setProjectNote, setTableGroup, setTableNote, upsertGroup } from "../annotationEdits";

const base = emptyAnnotations();

describe("annotationEdits", () => {
  it("starts from a valid empty file", () => {
    expect(emptyAnnotations()).toEqual({ formatVersion: 1 });
  });

  it("never mutates its input", () => {
    // Every function returns a new file. Mutating in place would make Vue's
    // reactivity miss the change and make undo impossible to add later.
    const before = JSON.stringify(base);
    setTableNote(base, "public.orders", "hello");
    expect(JSON.stringify(base)).toBe(before);
  });

  it("sets and clears a table note", () => {
    const withNote = setTableNote(base, "public.orders", "One row per checkout.");
    expect(withNote.tables?.["public.orders"].note).toBe("One row per checkout.");

    const cleared = setTableNote(withNote, "public.orders", "   ");
    expect(cleared.tables?.["public.orders"]).toBeUndefined();
  });

  it("keeps a table entry when it still carries a group after the note clears", () => {
    // Dropping the whole entry here would silently unassign the group.
    const grouped = setTableGroup(setTableNote(base, "public.orders", "n"), "public.orders", "g1");
    const cleared = setTableNote(grouped, "public.orders", "");
    expect(cleared.tables?.["public.orders"].group).toBe("g1");
    expect(cleared.tables?.["public.orders"].note).toBeUndefined();
  });

  it("sets and clears a column note", () => {
    const withNote = setColumnNote(base, "public.orders", "status", "Lifecycle state.");
    expect(withNote.tables?.["public.orders"].columns?.status.note).toBe("Lifecycle state.");

    const cleared = setColumnNote(withNote, "public.orders", "status", "");
    expect(cleared.tables?.["public.orders"]).toBeUndefined();
  });

  it("upserts a group by id", () => {
    const created = upsertGroup(base, { id: "g1", name: "Core", hue: 28 });
    expect(created.groups).toEqual([{ id: "g1", name: "Core", hue: 28 }]);

    const renamed = upsertGroup(created, { id: "g1", name: "Core Accounts", hue: 200 });
    expect(renamed.groups).toHaveLength(1);
    expect(renamed.groups?.[0]).toEqual({ id: "g1", name: "Core Accounts", hue: 200 });
  });

  it("removing a group also clears every table that referenced it", () => {
    // A dangling groupId renders as no group at all, so the file would look
    // correct while carrying a reference to something that does not exist.
    const withGroup = setTableGroup(upsertGroup(base, { id: "g1", name: "Core", hue: 28 }), "public.orders", "g1");
    const removed = removeGroup(withGroup, "g1");

    expect(removed.groups ?? []).toEqual([]);
    expect(removed.tables?.["public.orders"]).toBeUndefined();
  });

  it("removing a group keeps a table that still has a note", () => {
    const seeded = setTableNote(setTableGroup(upsertGroup(base, { id: "g1", name: "Core", hue: 28 }), "public.orders", "g1"), "public.orders", "keep me");
    const removed = removeGroup(seeded, "g1");
    expect(removed.tables?.["public.orders"].note).toBe("keep me");
    expect(removed.tables?.["public.orders"].group).toBeUndefined();
  });

  it("sets and clears the project note", () => {
    const withNote = setProjectNote(base, "# Sales\n\nThe billing schema.");
    expect(withNote.project?.note).toBe("# Sales\n\nThe billing schema.");
    expect(setProjectNote(withNote, "").project).toBeUndefined();
  });
});
