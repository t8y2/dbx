import { describe, expect, it } from "vitest";
import { buildSelectedSkillChips, removeSkillIds, userSkillSourceOfId } from "@/lib/ai/userSkillSelection";
import type { UserSkillMeta } from "@/types/userSkills";

const catalog: Record<string, UserSkillMeta> = {
  "d-aaa": { id: "d-aaa", name: "SQL Review", description: "review rules" },
  "c-bbb": { id: "c-bbb", name: "Team Rules", description: "team rules" },
};
const lookup = (id: string): UserSkillMeta | undefined => catalog[id];

describe("selected skill chips", () => {
  it("keeps a chip for every selected id, including vanished ones", () => {
    // Regression anchor for "unavailable skills have a visible recovery action":
    // `d-gone` is absent from the catalog (deleted after selection + refresh) and
    // must still render a removable chip rather than silently disappearing.
    const chips = buildSelectedSkillChips(["d-aaa", "d-gone", "c-bbb"], lookup);
    expect(chips.map((chip) => chip.id)).toEqual(["d-aaa", "d-gone", "c-bbb"]);
    expect(chips[1]).toEqual({ id: "d-gone", name: "d-gone", description: "", source: "default", unavailable: true });
    expect(chips[0].unavailable).toBe(false);
    expect(chips[0].name).toBe("SQL Review");
  });

  it("labels the source from the id prefix so a vanished skill keeps its origin", () => {
    expect(userSkillSourceOfId("c-bbb")).toBe("custom");
    expect(userSkillSourceOfId("d-aaa")).toBe("default");
    const chips = buildSelectedSkillChips(["c-gone"], lookup);
    expect(chips[0].source).toBe("custom");
    expect(chips[0].unavailable).toBe(true);
  });

  it("handles an empty selection", () => {
    expect(buildSelectedSkillChips([], lookup)).toEqual([]);
  });
});

describe("removeSkillIds", () => {
  it("drops the given ids and preserves the remaining order", () => {
    expect(removeSkillIds(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
    expect(removeSkillIds(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
  });

  it("is a no-op for unknown ids and empty removals", () => {
    const ids = ["a", "b"];
    expect(removeSkillIds(ids, [])).toEqual(ids);
    expect(removeSkillIds(ids, ["zzz"])).toEqual(ids);
    expect(removeSkillIds(ids, ["a", "a"])).toEqual(["b"]);
  });
});
