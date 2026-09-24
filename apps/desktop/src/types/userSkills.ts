/**
 * Read-only user-level SKILL.md skills (prd 09-21-public-skill-loader).
 * Ids are opaque and deterministic (root source + canonical relative skill path);
 * absolute filesystem paths never cross this boundary.
 */

export interface UserSkillMeta {
  id: string;
  name: string;
  description: string;
}

export interface UserSkillRootListing {
  status: "ok" | "missing" | "invalid";
  skills: UserSkillMeta[];
}

export interface UserSkillsListResult {
  defaultRoot: UserSkillRootListing;
  customRoot: UserSkillRootListing | null;
}

export interface ReadUserSkill {
  id: string;
  name: string;
  description: string;
  content: string;
}

export type UserSkillFailureReason = "not_found" | "root_unavailable" | "oversized" | "not_utf8" | "invalid_frontmatter" | "unreadable";

export interface ReadUserSkillFailure {
  id: string;
  reason: UserSkillFailureReason;
}

export interface UserSkillsReadResult {
  skills: ReadUserSkill[];
  failures: ReadUserSkillFailure[];
}

export interface UserSkillRootSettings {
  customRootEnabled: boolean;
  customRoot: string | null;
}

/**
 * Combined character budget for skills injected into one AI request. Skill
 * bodies are only known after the send-time read (the catalog is metadata
 * only), so the budget is enforced on the read snapshots with the same
 * semantics as the template budget.
 */
export const ACTIVE_SKILLS_TOTAL_MAX = 65536;
