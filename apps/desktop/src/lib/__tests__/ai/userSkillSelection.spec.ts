import { describe, expect, it } from "vitest";
import { buildSelectedSkillChips, capSkillsToCharLimit, removeSkillIds, userSkillSourceOfId } from "@/lib/ai/userSkillSelection";
import { ACTIVE_SKILLS_TOTAL_MAX, type ReadUserSkill, type UserSkillMeta } from "@/types/userSkills";

const catalog: Record<string, UserSkillMeta> = {
  "d-aaa": { id: "d-aaa", name: "SQL Review", description: "review rules" },
  "c-bbb": { id: "c-bbb", name: "Team Rules", description: "team rules" },
};
const lookup = (id: string): UserSkillMeta | undefined => catalog[id];

function skill(id: string, content: string): ReadUserSkill {
  return { id, name: id, description: "", content };
}

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

describe("capSkillsToCharLimit", () => {
  it("keeps leading skills that fit the combined budget and skips overflowing ones", () => {
    // Regression anchor for "selected skills cannot grow the system prompt
    // without bound": the first skill fills the budget, the oversized second
    // is skipped, and the smaller third still fits.
    const big = "x".repeat(60);
    const capped = capSkillsToCharLimit([skill("d-1", "a".repeat(30)), skill("d-2", big), skill("d-3", "b".repeat(10))], 50);
    expect(capped.map((s) => s.id)).toEqual(["d-1", "d-3"]);
  });

  it("drops a single skill whose content alone exceeds the budget", () => {
    expect(capSkillsToCharLimit([skill("d-1", "x".repeat(ACTIVE_SKILLS_TOTAL_MAX + 1))], ACTIVE_SKILLS_TOTAL_MAX)).toEqual([]);
    expect(capSkillsToCharLimit([skill("d-1", "x".repeat(ACTIVE_SKILLS_TOTAL_MAX))], ACTIVE_SKILLS_TOTAL_MAX).map((s) => s.id)).toEqual(["d-1"]);
  });

  it("preserves selection order and dedupes repeated ids", () => {
    const capped = capSkillsToCharLimit([skill("d-1", "a"), skill("d-2", "b"), skill("d-1", "a")], 10);
    expect(capped.map((s) => s.id)).toEqual(["d-1", "d-2"]);
  });

  it("keeps everything under the real budget for realistic sizes", () => {
    const skills = Array.from({ length: 8 }, (_, i) => skill(`d-${i}`, "y".repeat(2000)));
    expect(capSkillsToCharLimit(skills, ACTIVE_SKILLS_TOTAL_MAX).length).toBe(8);
  });
});
