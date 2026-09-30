/**
 * Skill listing rendering for on-demand skill loading
 * (prd 09-30-skill-listing-use-skill).
 *
 * The system prompt carries only this listing — frontmatter-derived name and
 * description — never a SKILL.md body. Bodies reach the model through the
 * `use_skill` tool when the model decides the skill applies to the turn.
 *
 * Pure functions only: the budget ladder is the contract the regression tests
 * pin, so keep every decision deterministic.
 */

import { promptTemplateCharacterCount } from "@/types/promptTemplate";
import type { UserSkillMeta } from "@/types/userSkills";
import { userSkillSourceOfId } from "@/lib/ai/userSkillSelection";

/** Description cap for a normal entry. Measured p100 of real SKILL.md descriptions is 997, so this truncates nothing in practice. */
export const SKILL_LISTING_ENTRY_MAX = 1000;
/** Description cap an unselected entry degrades to (≈ the measured median of 233) before losing its description entirely. */
export const SKILL_LISTING_UNCHECKED_ENTRY_MAX = 200;
/** Combined listing budget for one request. Deliberately above ACTIVE_TEMPLATES_TOTAL_MAX (16000). */
export const SKILL_LISTING_TOTAL_MAX = 32000;
/** Fuse against a pathological skill count; the character budget binds first in practice. */
export const SKILL_LISTING_MAX_ENTRIES = 100;

/** Language-neutral so one listing line reads the same under every locale. */
const SELECTED_MARKER = "user-selected";

export interface SkillListingInput {
  /** Catalog metadata, both roots. */
  skills: readonly UserSkillMeta[];
  /** Ids the user checked for this AI panel session. */
  selectedIds: readonly string[];
  totalMax?: number;
  entryMax?: number;
  uncheckedEntryMax?: number;
  maxEntries?: number;
}

export interface SkillListing {
  /** Rendered entry lines. */
  lines: string[];
  /** True when an entry lost its description or was dropped to fit. */
  truncated: boolean;
}

interface Entry {
  id: string;
  name: string;
  description: string;
  source: string;
  selected: boolean;
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(description: string, max: number): string {
  if (promptTemplateCharacterCount(description) <= max) return description;
  // Slice by code point so truncation never splits a surrogate pair.
  return `${Array.from(description)
    .slice(0, Math.max(max - 1, 0))
    .join("")}…`;
}

function renderEntry(entry: Entry, descriptionMax: number): string {
  const markers = [entry.source, ...(entry.selected ? [SELECTED_MARKER] : [])].join("] [");
  const head = `- ${flat(entry.name)} [${markers}]`;
  if (descriptionMax <= 0) return head;
  const description = truncate(flat(entry.description), descriptionMax);
  return description ? `${head}: ${description}` : head;
}

function size(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + promptTemplateCharacterCount(line) + 1, 0) - 1;
}

/**
 * Existing #9363 ordering: the custom root lists before the default root, then
 * name (case-insensitive), then the opaque id as a stable tiebreak. Two skills
 * sharing a name across roots stay separate — the source marker in each line is
 * what lets the model, and the user reading the transcript, tell them apart.
 */
function compareEntries(a: Entry, b: Entry): number {
  if (a.source !== b.source) return a.source === "custom" ? -1 : 1;
  const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/**
 * Render the listing within budget.
 *
 * Ladder — each step runs only while the previous one still overflows:
 *   1. every entry with its full description;
 *   2. unselected entries clamped to `uncheckedEntryMax`;
 *   3. unselected entries reduced to name + source;
 *   4. unselected entries dropped from the tail.
 *
 * Selected entries never lose their description and are never dropped: they are
 * the user's explicit intent, and their description is the only routing signal
 * the model receives for them. If the selected entries alone exceed the budget
 * the listing overflows rather than silently dropping one of them.
 */
export function buildSkillListing(input: SkillListingInput): SkillListing {
  const totalMax = input.totalMax ?? SKILL_LISTING_TOTAL_MAX;
  const entryMax = input.entryMax ?? SKILL_LISTING_ENTRY_MAX;
  const uncheckedEntryMax = input.uncheckedEntryMax ?? SKILL_LISTING_UNCHECKED_ENTRY_MAX;
  const maxEntries = input.maxEntries ?? SKILL_LISTING_MAX_ENTRIES;

  // One global order for every entry — selected entries are made prominent by
  // their marker, not by being hoisted, so the listing reads the same way
  // regardless of what the user picked (prd: ordering follows #9363).
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const skill of input.skills) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    entries.push({
      id: skill.id,
      name: skill.name,
      description: skill.description ?? "",
      source: userSkillSourceOfId(skill.id),
      selected: input.selectedIds.includes(skill.id),
    });
  }
  entries.sort(compareEntries);

  // Only unselected entries are ever dropped, so both the entry cap and the
  // final ladder rung consume this list from its tail.
  const unselectedPositions = entries.flatMap((entry, index) => (entry.selected ? [] : [index]));
  const selectedCount = entries.length - unselectedPositions.length;

  const assemble = (droppedCount: number, descriptionMax: (entry: Entry) => number) => {
    const dropped = new Set(unselectedPositions.slice(unselectedPositions.length - droppedCount));
    return entries.filter((_, index) => !dropped.has(index)).map((entry) => renderEntry(entry, descriptionMax(entry)));
  };

  // Selected entries are never dropped, so the entry cap can only ever bite the
  // unselected tail.
  const droppedByCount = Math.max(unselectedPositions.length - Math.max(maxEntries - selectedCount, 0), 0);

  const full = assemble(droppedByCount, () => entryMax);
  if (size(full) <= totalMax) return { lines: full, truncated: droppedByCount > 0 };

  const clamped = assemble(droppedByCount, (entry) => (entry.selected ? entryMax : uncheckedEntryMax));
  if (size(clamped) <= totalMax) return { lines: clamped, truncated: true };

  for (let dropped = droppedByCount; dropped <= unselectedPositions.length; dropped += 1) {
    const lines = assemble(dropped, (entry) => (entry.selected ? entryMax : 0));
    if (size(lines) <= totalMax || dropped === unselectedPositions.length) {
      // The last rung keeps only the selected entries; they stay even if that
      // still overflows the budget, because silently dropping one of the user's
      // explicit picks is worse than an oversized listing.
      return { lines, truncated: true };
    }
  }
  /* istanbul ignore next -- the loop above always returns at its last rung. */
  return { lines: assemble(unselectedPositions.length, () => entryMax), truncated: true };
}

/**
 * The prompt block. Kept beside the renderer so the strong wording for
 * user-selected skills — the only thing standing in for the removed
 * force-injection — is covered by the same tests as the budget ladder.
 */
export function buildSkillListingLines(listing: SkillListing, isZh: boolean): string[] {
  if (listing.lines.length === 0) return [];
  const body = listing.lines.join("\n");
  return [
    isZh
      ? `## 可用 Skills（按需加载）\n以下 Skill 只有名称与描述在上下文中，正文不在。需要某个 Skill 的完整指令时，先调用 use_skill 工具加载它，再按其中的规则回答。\n标有 [${SELECTED_MARKER}] 的 Skill 由用户显式选择：本轮问题与它相关时，必须先调用 use_skill 加载后再回答。\n\n${body}`
      : `## Available Skills (loaded on demand)\nOnly names and descriptions are in context; the bodies are not. When you need a skill's full instructions, call the use_skill tool first and follow it before answering.\nSkills marked [${SELECTED_MARKER}] were chosen explicitly by the user: when the current request touches them, call use_skill before answering.\n\n${body}`,
  ];
}
