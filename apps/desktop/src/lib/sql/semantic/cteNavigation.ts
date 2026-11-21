/**
 * CTE (WITH ... AS) navigation helpers shared by Ctrl/Cmd+click and hover handling.
 *
 * A CTE appears twice in the semantic model:
 * - a **definition** row source (`id` prefix `cte:`) carrying `nameSpan` / `bodySpan` /
 *   `cteOutputs` / `cteStars` / `bodySources` enrichment;
 * - zero or more **reference** row sources (`from:` / `join:` …, `kind: "cte"`) where the
 *   CTE is used as a row source by another query block.
 *
 * Derived tables (`kind: "subquery"`) that sit directly inside a CTE body carry the same body
 * enrichment, which lets a lineage keep tracing through `FROM (SELECT ...) x` to the physical
 * tables inside the inline view.
 */

import type { SqlSemanticCteOutputColumn, SqlSemanticCteStar, SqlSemanticModel, SqlSemanticRowSource } from "@/lib/sql/semantic/types";

/** CTE chains can nest (a → b → physical table); stop well before pathological recursion. */
const MAX_CTE_ORIGIN_DEPTH = 8;

function containsPosition(span: { start: number; end: number }, position: number): boolean {
  return position >= span.start && position <= span.end;
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** CTE definition row sources (`WITH c AS (...)`) in declaration order. */
export function cteDefinitionSources(model: SqlSemanticModel): SqlSemanticRowSource[] {
  return model.rowSources.filter((source) => source.kind === "cte" && source.id.startsWith("cte:"));
}

/** CTE *usages* as row sources (`FROM/JOIN cte`), excluding the definitions themselves. */
export function cteReferenceSources(model: SqlSemanticModel): SqlSemanticRowSource[] {
  return model.rowSources.filter((source) => source.kind === "cte" && !source.id.startsWith("cte:"));
}

function findCteDefinition(model: SqlSemanticModel, name: string): SqlSemanticRowSource | undefined {
  const definitions = cteDefinitionSources(model);
  for (let index = definitions.length - 1; index >= 0; index -= 1) {
    const definition = definitions[index];
    if (definition && sameName(definition.name, name)) return definition;
  }
  return undefined;
}

export interface CteReferenceHit {
  reference: SqlSemanticRowSource;
  definition: SqlSemanticRowSource;
}

/**
 * Position lies on an outer-query CTE reference name or alias (never on the definition name
 * itself — definitions have no `qualifiedName` and are excluded by id prefix).
 */
export function findCteReferenceAt(model: SqlSemanticModel, position: number): CteReferenceHit | null {
  for (const reference of cteReferenceSources(model)) {
    const onName = !!reference.qualifiedName && containsPosition(reference.qualifiedName.span, position);
    const onAlias = !!reference.aliasSpan && containsPosition(reference.aliasSpan, position);
    if (!onName && !onAlias) continue;
    const definition = findCteDefinition(model, reference.name);
    if (!definition?.nameSpan) continue;
    return { reference, definition };
  }
  return null;
}

export interface CteColumnHit {
  definition: SqlSemanticRowSource;
  /** Matched named output column; absent when the column arrives via a body star. */
  output?: SqlSemanticCteOutputColumn;
  /**
   * Every star projection that could supply the column, in body order (absent when a named output
   * matched). All of them are kept instead of the first one, because `SELECT a.*, b.*` gives no
   * way to tell which star owns the column without column metadata — callers pick among the traced
   * origins with the metadata they already fetch.
   */
  stars?: SqlSemanticCteStar[];
}

/** Nesting depth of the parenthesis range containing `position` (0 at statement level). */
function nestingDepthAt(model: SqlSemanticModel, position: number): number {
  let depth = 0;
  for (const token of model.tokens) {
    if (token.span.start > position) break;
    if (token.span.end > position) return token.depth;
    depth = token.depth;
  }
  return depth;
}

/**
 * Picks the matching named output, or the stars that can supply the column.
 * Note: a body `t.*` star still exposes its columns to the outer query both bare and
 * CTE-qualified (as `w.col`), so the outer qualifier never participates in star selection;
 * star qualifier parts only steer physical-source expansion during origin tracing.
 */
function resolveCteOutputOrStars(definition: SqlSemanticRowSource, columnName: string): CteColumnHit | null {
  const output = definition.cteOutputs?.find((candidate) => sameName(candidate.name, columnName));
  if (output) return { definition, output };

  const stars = definition.cteStars ?? [];
  if (stars.length === 0) return null;
  return { definition, stars };
}

/**
 * Resolves an outer-query column to the CTE that produces it. The model must be built at the
 * click/hover position (cursor intent drives qualified-column target resolution).
 *
 * - Qualified columns (`w.col`) use the cursor intent target source or the qualifier name, and
 *   resolve *only* through the CTE that owns that qualifier.
 * - Bare columns resolve only when exactly one CTE *visible at the cursor* supplies the name,
 *   otherwise `null` is returned so callers fall back to physical-table handling. Visibility means
 *   the CTE is declared before the cursor and is referenced at the cursor's own nesting level —
 *   without that guard a later, unrelated CTE body claims bare columns of an earlier query block.
 */
export function findCteColumnResolution(model: SqlSemanticModel, columnName: string, qualifier?: string): CteColumnHit | null {
  const intentTargetId = model.cursorIntent.targetSourceId;
  if (qualifier || intentTargetId) {
    let target: SqlSemanticRowSource | undefined;
    if (intentTargetId) {
      target = model.rowSources.find((source) => source.id === intentTargetId);
    }
    if (!target && qualifier) {
      target = cteReferenceSources(model).find((source) => (!!source.alias && sameName(source.alias, qualifier)) || sameName(source.name, qualifier));
    }
    // The qualifier owns the column: a physical table (or any other non-CTE row source) must never
    // fall through to the bare-column scan below, which ignores qualifiers and would let a
    // star-bodied CTE claim `t.id` from an unrelated physical table.
    if (!target || target.kind !== "cte" || target.id.startsWith("cte:")) return null;
    const definition = findCteDefinition(model, target.name);
    return definition ? resolveCteOutputOrStars(definition, columnName) : null;
  }

  const hits: CteColumnHit[] = [];
  const seenDefinitionIds = new Set<string>();
  const cursorDepth = nestingDepthAt(model, model.cursor);
  for (const reference of cteReferenceSources(model)) {
    const definition = findCteDefinition(model, reference.name);
    if (!definition || seenDefinitionIds.has(definition.id)) continue;
    // Only a CTE declared before the cursor *and* referenced in the cursor's own query block can
    // own a bare column; otherwise an unrelated query block (typically a CTE declared further
    // down, or one referenced only from a deeper subquery) hijacks the name and click/hover
    // lands on that far-away CTE.
    if (definition.sourceSpan.start > model.cursor) continue;
    if (nestingDepthAt(model, reference.sourceSpan.start) !== cursorDepth) continue;
    seenDefinitionIds.add(definition.id);
    const hit = resolveCteOutputOrStars(definition, columnName);
    if (hit) hits.push(hit);
  }
  return hits.length === 1 ? hits[0] : null;
}

/** A physical row source reached after tracing CTE output columns. */
export interface CteColumnOrigin {
  source: SqlSemanticRowSource;
  column: string;
}

function isPhysicalOriginSource(source: SqlSemanticRowSource): boolean {
  return source.kind === "table" || source.kind === "table_function" || source.kind === "mutation_target";
}

function sourceMatchesQualifier(source: SqlSemanticRowSource, qualifierParts: readonly string[]): boolean {
  const qualifier = qualifierParts[qualifierParts.length - 1]?.toLowerCase();
  if (!qualifier) return false;
  return source.alias?.toLowerCase() === qualifier || source.name.toLowerCase() === qualifier;
}

function dedupeOrigins(origins: CteColumnOrigin[]): CteColumnOrigin[] {
  const seen = new Set<string>();
  const result: CteColumnOrigin[] = [];
  for (const origin of origins) {
    const key = `${origin.source.sourceSpan.start}:${origin.source.sourceSpan.end}:${origin.column.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(origin);
  }
  return result;
}

function originsForDefinition(model: SqlSemanticModel, definition: SqlSemanticRowSource, hit: CteColumnHit, columnName: string, visited: Set<string>, depth: number): CteColumnOrigin[] {
  if (depth > MAX_CTE_ORIGIN_DEPTH || visited.has(definition.id)) return [];
  visited.add(definition.id);

  if (hit.output?.origin) {
    const { qualifierParts, column } = hit.output.origin;
    return expandOriginSources(model, definition, qualifierParts, column, visited, depth);
  }
  if (hit.stars && hit.stars.length > 0) {
    // `SELECT a.*, b.*` yields one candidate star per body source; trace them all and let the
    // caller's column metadata decide which one actually owns the name (see CteColumnHit.stars).
    return dedupeOrigins(hit.stars.flatMap((star) => expandStarSources(model, definition, star, columnName, visited, depth)));
  }
  return [];
}

function followBodySource(model: SqlSemanticModel, ownerDefinition: SqlSemanticRowSource, source: SqlSemanticRowSource, column: string, visited: Set<string>, depth: number): CteColumnOrigin[] {
  // Recursive CTE self-reference — never trace back into the same definition.
  if (sameName(source.name, ownerDefinition.name)) return [];
  if (source.kind === "cte") {
    const upstream = findCteDefinition(model, source.name);
    if (!upstream) return [];
    const upstreamHit = resolveCteOutputOrStars(upstream, column);
    if (!upstreamHit) return [];
    return originsForDefinition(model, upstream, upstreamHit, column, visited, depth + 1);
  }
  if (source.kind === "subquery") {
    // Derived table (enriched only when it sits directly inside a CTE body): resolve the column
    // against the inline view's own projections/stars, then keep tracing inside its body.
    const innerHit = resolveCteOutputOrStars(source, column);
    return innerHit ? originsForDefinition(model, source, innerHit, column, visited, depth + 1) : [];
  }
  if (isPhysicalOriginSource(source)) {
    return [{ source, column }];
  }
  return [];
}

function expandOriginSources(model: SqlSemanticModel, definition: SqlSemanticRowSource, qualifierParts: readonly string[], column: string, visited: Set<string>, depth: number): CteColumnOrigin[] {
  const sources = definition.bodySources ?? [];
  // Bare columns may come from any source, including an upstream CTE (chain); followBodySource
  // itself decides which source kinds are traceable.
  const matched = qualifierParts.length > 0 ? sources.filter((source) => sourceMatchesQualifier(source, qualifierParts)) : sources;
  const origins: CteColumnOrigin[] = [];
  for (const source of matched) {
    origins.push(...followBodySource(model, definition, source, column, visited, depth));
  }
  return dedupeOrigins(origins);
}

function expandStarSources(model: SqlSemanticModel, definition: SqlSemanticRowSource, star: SqlSemanticCteStar, columnName: string, visited: Set<string>, depth: number): CteColumnOrigin[] {
  const sources = (definition.bodySources ?? []).filter((source) => !sameName(source.name, definition.name));
  const matched = star.qualifierParts.length > 0 ? sources.filter((source) => sourceMatchesQualifier(source, star.qualifierParts)) : sources;
  const origins: CteColumnOrigin[] = [];
  for (const source of matched) {
    origins.push(...followBodySource(model, definition, source, columnName, visited, depth));
  }
  return dedupeOrigins(origins);
}

/**
 * Traces a resolved CTE column through simple projections and CTE chains down to the physical
 * table column(s) whose metadata can drive hover comments. Returns an empty list for
 * expressions, explicit-list mismatches, cycles, or over-deep chains — callers then fall back.
 */
export function resolveCteColumnOrigins(model: SqlSemanticModel, hit: CteColumnHit, outerColumnName: string): CteColumnOrigin[] {
  return originsForDefinition(model, hit.definition, hit, outerColumnName, new Set<string>(), 0);
}
