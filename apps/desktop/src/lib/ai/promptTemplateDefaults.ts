import type { PromptTemplate } from "@/types/promptTemplate";
import { promptTemplateCharacterCount } from "@/types/promptTemplate";

export interface AutoTemplateResolutionInput {
  dbType?: string;
  defaultTemplatesByDbType: Record<string, string[]>;
  lastUsedTemplatesByDbType: Record<string, string[]>;
}

/**
 * Template ids explicitly configured as defaults for the db_type, or empty
 * when none are configured. Namespace-switch resolution must stop here:
 * falling back to last-used would resurrect selections the user just cleared
 * on every connection/database/schema change.
 */
export function resolveDefaultTemplateIds(dbType: string | undefined, defaultTemplatesByDbType: Record<string, string[]>): string[] {
  if (!dbType) return [];
  const defaults = defaultTemplatesByDbType[dbType];
  return defaults && defaults.length > 0 ? [...defaults] : [];
}

/**
 * Template ids to auto-select when a panel opens, keyed by the connection's
 * db_type: explicit defaults win over the last-used fallback. Both records are
 * scoped per db_type so a template tuned for one database never leaks into a
 * namespace of another database type.
 */
export function resolveAutoTemplateIds({ dbType, defaultTemplatesByDbType, lastUsedTemplatesByDbType }: AutoTemplateResolutionInput): string[] {
  const defaults = resolveDefaultTemplateIds(dbType, defaultTemplatesByDbType);
  if (defaults.length > 0) return defaults;
  if (!dbType) return [];
  const lastUsed = lastUsedTemplatesByDbType[dbType];
  return lastUsed && lastUsed.length > 0 ? [...lastUsed] : [];
}

/**
 * Keep only ids that still exist among templates, deduplicated, dropping any
 * single template whose content would push the combined total past maxTotal
 * (same budget the manual multi-select enforces). A later smaller template is
 * still applied so one oversized default cannot shadow the remaining defaults.
 */
export function capTemplateIdsToCharLimit(ids: string[], templates: PromptTemplate[], maxTotal: number): string[] {
  const byId = new Map(templates.map((template) => [template.id, template]));
  const kept: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const template = byId.get(id);
    if (!template) continue;
    const size = promptTemplateCharacterCount(template.content);
    if (total + size > maxTotal) continue;
    total += size;
    kept.push(id);
  }
  return kept;
}
