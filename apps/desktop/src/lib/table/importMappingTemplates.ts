import { IMPORT_SKIP_TARGET, normalizeImportColumnName } from "@/lib/table/tableImport";

/**
 * Saved source-column → target-column mappings for the table import dialog, so a file with the
 * same layout can be mapped again (for example into another database) without redoing it by hand.
 */
export interface ImportMappingTemplate {
  name: string;
  /** Source column name → target column name. Skipped columns are not stored. */
  mapping: Record<string, string>;
}

export const IMPORT_MAPPING_TEMPLATES_STORAGE_KEY = "dbx-table-import-mapping-templates";

type TemplateStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): TemplateStorage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

function cleanMapping(raw: unknown): Record<string, string> {
  const mapping: Record<string, string> = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return mapping;
  for (const [source, target] of Object.entries(raw)) {
    if (typeof target === "string" && source.trim() && target.trim()) mapping[source] = target;
  }
  return mapping;
}

/** Reads the saved templates; anything malformed is ignored rather than failing the dialog. */
export function readImportMappingTemplates(storage: TemplateStorage | undefined = defaultStorage()): ImportMappingTemplate[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(IMPORT_MAPPING_TEMPLATES_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const templates: ImportMappingTemplate[] = [];
    for (const item of parsed) {
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      const mapping = cleanMapping(item?.mapping);
      if (name && Object.keys(mapping).length > 0 && !templates.some((template) => template.name.toLowerCase() === name.toLowerCase())) templates.push({ name, mapping });
    }
    return templates;
  } catch {
    return [];
  }
}

export function writeImportMappingTemplates(templates: ImportMappingTemplate[], storage: TemplateStorage | undefined = defaultStorage()): void {
  try {
    storage?.setItem(IMPORT_MAPPING_TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
  } catch {
    // Ignore storage quota or access errors; the templates then last for this session only.
  }
}

/** Adds the template, replacing one with the same name (case-insensitive). An empty mapping or name changes nothing. */
export function withImportMappingTemplate(templates: ImportMappingTemplate[], name: string, mapping: Record<string, string>): ImportMappingTemplate[] {
  const trimmed = name.trim();
  const cleaned = cleanMapping(mapping);
  if (!trimmed || Object.keys(cleaned).length === 0) return templates;
  return [...templates.filter((template) => template.name.toLowerCase() !== trimmed.toLowerCase()), { name: trimmed, mapping: cleaned }];
}

export function withoutImportMappingTemplate(templates: ImportMappingTemplate[], name: string): ImportMappingTemplate[] {
  return templates.filter((template) => template.name.toLowerCase() !== name.trim().toLowerCase());
}

/**
 * Maps the file's columns through a template. A source column matches the template's source
 * names exactly, then ignoring case and separators; its target must exist in the table
 * (matched the same way, using the table's spelling). Everything else is skipped.
 */
export function applyImportMappingTemplate(template: ImportMappingTemplate, sourceColumns: string[], targetColumns: string[]): { mapping: Record<string, string>; matched: number } {
  const targetsByName = new Map(targetColumns.map((column) => [normalizeImportColumnName(column), column]));
  const templateTargets = new Map<string, string>();
  for (const [source, target] of Object.entries(template.mapping)) {
    const key = normalizeImportColumnName(source);
    if (!templateTargets.has(key)) templateTargets.set(key, target);
  }
  const mapping: Record<string, string> = Object.create(null);
  const used = new Set<string>();
  let matched = 0;
  for (const source of sourceColumns) {
    const wanted = Object.prototype.hasOwnProperty.call(template.mapping, source) ? template.mapping[source] : templateTargets.get(normalizeImportColumnName(source));
    const target = wanted === undefined ? undefined : targetColumns.includes(wanted) ? wanted : targetsByName.get(normalizeImportColumnName(wanted));
    // Two file columns must not land in the same table column.
    if (target !== undefined && !used.has(target)) {
      mapping[source] = target;
      used.add(target);
      matched += 1;
    } else {
      mapping[source] = IMPORT_SKIP_TARGET;
    }
  }
  return { mapping, matched };
}
