import { describe, expect, it } from "vitest";

import { buildSkillListing, buildSkillListingLines, SKILL_LISTING_UNCHECKED_ENTRY_MAX } from "@/lib/ai/skillListing";
import type { UserSkillMeta } from "@/types/userSkills";

function meta(id: string, name: string, description: string): UserSkillMeta {
  return { id, name, description };
}

/** `- a [default]: x` — one long-enough description to make each ladder rung reachable. */
const LONG = "d".repeat(900);

describe("buildSkillListing", () => {
  it("returns nothing for an empty catalog", () => {
    expect(buildSkillListing({ skills: [], selectedIds: [] }).lines).toEqual([]);
  });

  it("marks the source root and flags user-selected entries", () => {
    const listing = buildSkillListing({
      skills: [meta("d-1", "alpha", "A rules"), meta("c-2", "beta", "B rules")],
      selectedIds: ["d-1"],
    });

    expect(listing.lines).toEqual(["- beta [custom]: B rules", "- alpha [default] [user-selected]: A rules"]);
    expect(listing.truncated).toBe(false);
  });

  it("orders custom-root entries first, then by name, then by id", () => {
    const listing = buildSkillListing({
      skills: [meta("d-b", "zeta", "z"), meta("c-a", "Alpha", "a"), meta("d-a", "alpha", "a2"), meta("c-b", "alpha", "a3")],
      selectedIds: [],
    });

    expect(listing.lines.map((line) => line.split(":")[0])).toEqual(["- Alpha [custom]", "- alpha [custom]", "- alpha [default]", "- zeta [default]"]);
  });

  it("drops duplicate ids instead of rendering a skill twice", () => {
    const listing = buildSkillListing({ skills: [meta("d-1", "alpha", "a"), meta("d-1", "alpha", "a")], selectedIds: [] });
    expect(listing.lines).toHaveLength(1);
  });

  it("flattens multi-line descriptions into a single line", () => {
    const listing = buildSkillListing({ skills: [meta("d-1", "alpha", "line one\nline two")], selectedIds: [] });
    expect(listing.lines).toEqual(["- alpha [default]: line one line two"]);
  });

  // Ladder rung 1 → 2: an unselected description clamps to 200 while the
  // selected entry keeps its full description, because the user's explicit
  // pick is the only routing signal the model gets for it.
  it("clamps unselected descriptions before touching selected ones", () => {
    const listing = buildSkillListing({
      skills: [meta("d-1", "picked", LONG), meta("d-2", "other", LONG)],
      selectedIds: ["d-1"],
      totalMax: 1500,
    });

    expect(listing.truncated).toBe(true);
    const picked = listing.lines.find((line) => line.includes("picked"));
    expect(picked).toBe(`- picked [default] [user-selected]: ${LONG}`);

    const other = listing.lines.find((line) => line.includes("other"));
    const description = other!.split(": ")[1];
    expect(description.endsWith("…")).toBe(true);
    expect(Array.from(description)).toHaveLength(SKILL_LISTING_UNCHECKED_ENTRY_MAX);
  });

  // Ladder rung 2 → 3.
  it("reduces unselected entries to name and source when the clamp is still too wide", () => {
    const listing = buildSkillListing({
      skills: [meta("d-1", "picked", LONG), meta("d-2", "other", LONG)],
      selectedIds: ["d-1"],
      totalMax: 1000,
    });

    expect(listing.lines).toContain(`- picked [default] [user-selected]: ${LONG}`);
    expect(listing.lines).toContain("- other [default]");
  });

  // Ladder rung 3 → 4: selected entries survive even when they alone overflow
  // the budget; the listing reports the overflow instead of dropping them.
  it("drops unselected entries from the tail and never drops a selected one", () => {
    const listing = buildSkillListing({
      skills: [meta("d-1", "picked", LONG), meta("d-2", "other", LONG), meta("d-3", "another", LONG)],
      selectedIds: ["d-1"],
      totalMax: 500,
    });

    expect(listing.truncated).toBe(true);
    expect(listing.lines).toEqual(["- picked [default] [user-selected]: " + LONG]);
  });

  it("caps the entry count on the unselected tail only", () => {
    const skills = [meta("d-1", "picked", "p"), meta("d-2", "a", "a"), meta("d-3", "b", "b")];
    const listing = buildSkillListing({ skills, selectedIds: ["d-1"], maxEntries: 2 });

    // Global name order is a, b, picked — the cap drops the last unselected
    // entry (b) and keeps the selected one regardless of its position.
    expect(listing.truncated).toBe(true);
    expect(listing.lines).toEqual(["- a [default]: a", "- picked [default] [user-selected]: p"]);
  });
});

describe("buildSkillListingLines", () => {
  it("emits nothing without entries, so an unused skill feature leaves the prompt untouched", () => {
    expect(buildSkillListingLines({ lines: [], truncated: false }, false)).toEqual([]);
  });

  it("names the use_skill tool and the user-selected marker in both locales", () => {
    const listing = buildSkillListing({ skills: [meta("d-1", "alpha", "a")], selectedIds: ["d-1"] });

    const en = buildSkillListingLines(listing, false).join("\n");
    expect(en).toContain("use_skill");
    expect(en).toContain("user-selected");
    expect(en).toContain("- alpha [default] [user-selected]: a");

    const zh = buildSkillListingLines(listing, true).join("\n");
    expect(zh).toContain("use_skill");
    expect(zh).toContain("user-selected");
  });
});
