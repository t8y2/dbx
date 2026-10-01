import type { UserSkillMeta } from "@/types/userSkills";

/** A selected skill rendered as a chip, whether or not it is still discoverable. */
export interface SelectedSkillChip {
  id: string;
  name: string;
  description: string;
  source: "custom" | "default";
  /** True when the catalog no longer lists this id (deleted, or its root went away). */
  unavailable: boolean;
  /**
   * True once this conversation has had the skill loaded — by the model through
   * `use_skill`, or by the user forcing the load (prd 09-30 Req 13). A persistent
   * per-conversation signal, never a per-turn one.
   */
  loaded: boolean;
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
 *
 * `loadedIds` is the conversation's loaded set; an omitted one leaves every chip
 * in its default state, which is what a caller with no conversation state wants.
 */
export function buildSelectedSkillChips(ids: readonly string[], lookup: (id: string) => UserSkillMeta | undefined, loadedIds: Iterable<string> = []): SelectedSkillChip[] {
  const loaded = new Set(loadedIds);
  return ids.map((id) => {
    const meta = lookup(id);
    return {
      id,
      name: meta?.name ?? id,
      description: meta?.description ?? "",
      source: userSkillSourceOfId(id),
      unavailable: !meta,
      loaded: loaded.has(id),
    };
  });
}

/** Order-preserving removal, shared by the chip close button and the failure banner. */
export function removeSkillIds(ids: readonly string[], removed: Iterable<string>): string[] {
  const dropped = new Set(removed);
  return ids.filter((id) => !dropped.has(id));
}
