import type { ReadUserSkill, UserSkillMeta } from "@/types/userSkills";
import { promptTemplateCharacterCount } from "@/types/promptTemplate";

/** A selected skill rendered as a chip, whether or not it is still discoverable. */
export interface SelectedSkillChip {
  id: string;
  name: string;
  description: string;
  source: "custom" | "default";
  /** True when the catalog no longer lists this id (deleted, or its root went away). */
  unavailable: boolean;
}

/**
 * The backend mints ids as `<root>-<digest>` (`c-` custom root, `d-` default
 * root). Deriving the source from that prefix instead of from the catalog keeps
 * a selected skill labeled and removable after it disappears from discovery.
 */
export function userSkillSourceOfId(id: string): "custom" | "default" {
  return id.startsWith("c-") ? "custom" : "default";
}

/**
 * Every selected id keeps a chip: a skill that vanished from discovery would
 * otherwise lose its only remove affordance and block every later send. The
 * fallback label is the opaque id, paired with `unavailable` for styling.
 */
export function buildSelectedSkillChips(ids: readonly string[], lookup: (id: string) => UserSkillMeta | undefined): SelectedSkillChip[] {
  return ids.map((id) => {
    const meta = lookup(id);
    return {
      id,
      name: meta?.name ?? id,
      description: meta?.description ?? "",
      source: userSkillSourceOfId(id),
      unavailable: !meta,
    };
  });
}

/** Order-preserving removal, shared by the chip close button and the failure banner. */
export function removeSkillIds(ids: readonly string[], removed: Iterable<string>): string[] {
  const dropped = new Set(removed);
  return ids.filter((id) => !dropped.has(id));
}

/**
 * Keep the leading skills that fit the combined character budget for one
 * request. A skill whose content would push the total past maxTotal is
 * skipped, but a later smaller skill still fits (same budget semantics as
 * capTemplateIdsToCharLimit for templates). Selection order is preserved so
 * the injected set matches the chips top to bottom.
 */
export function capSkillsToCharLimit(skills: readonly ReadUserSkill[], maxTotal: number): ReadUserSkill[] {
  const kept: ReadUserSkill[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const skill of skills) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    const size = promptTemplateCharacterCount(skill.content);
    if (total + size > maxTotal) continue;
    total += size;
    kept.push(skill);
  }
  return kept;
}
