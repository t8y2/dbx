import type { CustomTypeAttributeDraft, CustomTypeDetails, CustomTypeDomainConstraintDraft, CustomTypeDraft, CustomTypeDraftDefinition, CustomTypeEnumValueDraft, CustomTypeKind, CustomTypeManagementCapabilities, CustomTypeOperation, CustomTypePlanIssue } from "@/types/database";

/**
 * Draft <-> snapshot conversion for the custom type designer.
 *
 * Every function here is pure so the editor's behaviour can be tested without
 * mounting a component or talking to a backend. The draft is always the *end
 * state* the user wants: the Rust planner diffs it against a live catalog
 * snapshot, which is why existing entries must carry their original identity.
 */

/** Kind of the type a draft describes. */
export function draftKind(draft: CustomTypeDraft): CustomTypeKind {
  return draft.definition.kind === "none" ? draft.definition.typeKind : draft.definition.kind;
}

/** Kinds the designer can create. Base and multirange have no structured form. */
export const CREATABLE_KINDS: readonly CustomTypeKind[] = ["enum", "composite", "domain", "range"];

export function operationForCreateKind(kind: CustomTypeKind): CustomTypeOperation | null {
  if (kind === "enum") return "create.enum";
  if (kind === "composite") return "create.composite";
  if (kind === "domain") return "create.domain";
  if (kind === "range") return "create.range";
  return null;
}

export function supportsOperation(capabilities: CustomTypeManagementCapabilities | null, operation: CustomTypeOperation): boolean {
  return capabilities?.operations?.[operation]?.supported === true;
}

/** Capabilities the designer needs for one kind. */
/**
 * Kinds the designer offers an edit entry for.
 *
 * A multirange is excluded on purpose: PostgreSQL generates it from its range
 * type, so renaming or moving it would leave `pg_range` describing a name that
 * no longer exists. The backend refuses those changes too.
 */
export function kindIsEditable(kind: CustomTypeKind): boolean {
  return kind !== "multirange";
}

export const KIND_EDIT_OPERATIONS: Record<CustomTypeKind, CustomTypeOperation[]> = {
  enum: ["alter.enum.addValue", "alter.enum.renameValue"],
  composite: ["alter.composite.addAttribute", "alter.composite.renameAttribute", "alter.composite.alterAttributeType", "alter.composite.dropAttribute"],
  domain: ["alter.domain.default", "alter.domain.notNull", "alter.domain.addConstraint", "alter.domain.renameConstraint", "alter.domain.dropConstraint", "alter.domain.validateConstraint"],
  // A range's definition is immutable; only the generic properties can change.
  range: [],
  multirange: [],
  base: [],
};

/** Whether the kind has any structural editor at all. */
export function kindHasStructuralEditor(kind: CustomTypeKind): boolean {
  return kind === "enum" || kind === "composite" || kind === "domain";
}

export function emptyDraft(kind: CustomTypeKind, schema: string): CustomTypeDraft {
  const base = { schema, name: "", owner: null, comment: null };
  switch (kind) {
    case "composite":
      return { ...base, definition: { kind: "composite", attributes: [newAttributeDraft()] } };
    case "domain":
      return {
        ...base,
        definition: { kind: "domain", baseType: "text", collation: null, default: null, notNull: false, constraints: [] },
      };
    case "range":
      return {
        ...base,
        definition: { kind: "range", subtype: "", subtypeOpclass: null, canonicalFunction: null, subtypeDiffFunction: null, multirangeName: null },
      };
    case "enum":
      return { ...base, definition: { kind: "enum", values: [newEnumValueDraft()] } };
    default:
      return { ...base, definition: { kind: "none", typeKind: kind } };
  }
}

export function newEnumValueDraft(): CustomTypeEnumValueDraft {
  return { value: "", originalValue: null };
}

export function newAttributeDraft(): CustomTypeAttributeDraft {
  return { name: "", originalName: null, dataType: "text", comment: null };
}

export function newConstraintDraft(): CustomTypeDomainConstraintDraft {
  return { name: "", originalName: null, expression: "", validated: null };
}

/**
 * Build the editable draft for an existing type.
 *
 * Existing entries keep their catalog identity (`originalValue` /
 * `originalName`) so the planner can tell a rename from an add-and-drop, and a
 * comment is carried as-is rather than defaulted, because `null` means "clear
 * this comment" to the planner.
 */
export function draftFromDetails(details: CustomTypeDetails): CustomTypeDraft {
  const base = {
    schema: details.schema,
    name: details.name,
    owner: details.owner ?? null,
    comment: details.comment ?? null,
  };
  switch (details.kind) {
    case "enum":
      return {
        ...base,
        definition: {
          kind: "enum",
          values: details.members.map((member) => member.enumValue ?? "").map((value) => ({ value, originalValue: value })),
        },
      };
    case "composite":
      return {
        ...base,
        definition: {
          kind: "composite",
          attributes: details.members.map((member) => ({
            name: member.name,
            originalName: member.name,
            dataType: member.dataType,
            comment: member.comment ?? null,
          })),
        },
      };
    case "domain":
      return {
        ...base,
        definition: {
          kind: "domain",
          baseType: details.properties.baseType ?? "",
          collation: details.properties.collation ?? null,
          default: details.properties.default ?? null,
          notNull: details.properties.notNull === true,
          constraints: details.properties.domainConstraints.map((constraint) => ({
            name: constraint.name,
            originalName: constraint.name,
            expression: constraint.definition,
            validated: constraint.validated ?? null,
          })),
        },
      };
    case "range":
      return {
        ...base,
        definition: {
          kind: "range",
          subtype: details.properties.rangeSubtype ?? "",
          subtypeOpclass: details.properties.rangeSubtypeOpclass ?? null,
          canonicalFunction: details.properties.rangeCanonicalFunction ?? null,
          subtypeDiffFunction: details.properties.rangeSubtypeDiffFunction ?? null,
          multirangeName: details.properties.rangeMultirangeName ?? null,
        },
      };
    default:
      // Base and multirange have no structured editor. The draft states the kind
      // and nothing else, so the planner sees an unchanged definition instead of
      // a fabricated Range that would fail its kind-immutability check.
      return { ...base, definition: { kind: "none", typeKind: details.kind } };
  }
}

/** Whether anything the planner looks at changed. */
export function draftIsDirty(original: CustomTypeDraft | null, current: CustomTypeDraft | null): boolean {
  if (!original || !current) return original !== current;
  return stableStringify(original) !== stableStringify(current);
}

/**
 * Client-side validation for immediate feedback only.
 *
 * The Rust planner re-runs every one of these checks; this exists so obvious
 * mistakes are visible before a round trip, never as the authority.
 */
export function draftValidationIssues(draft: CustomTypeDraft, isCreate: boolean): CustomTypePlanIssue[] {
  const issues: CustomTypePlanIssue[] = [];
  const block = (code: string, message: string, path: string) => {
    issues.push({ code, message, path, severity: "blocking" });
  };
  if (!draft.schema.trim()) block("identity.schema_required", "A schema is required.", "schema");
  if (!draft.name.trim()) block("identity.name_required", "A name is required.", "name");

  const definition = draft.definition;
  if (definition.kind === "enum") {
    const seen = new Set<string>();
    for (const entry of definition.values) {
      if (seen.has(entry.value)) {
        block("enum.duplicate_value", `Duplicate enum value: ${entry.value || "(empty)"}`, "definition.values");
        break;
      }
      seen.add(entry.value);
    }
    if (isCreate && definition.values.every((entry) => entry.value === "")) {
      block("enum.empty_name", "Add at least one enum value.", "definition.values");
    }
  }
  if (definition.kind === "composite") {
    const seen = new Set<string>();
    for (const attribute of definition.attributes) {
      const name = attribute.name;
      if (!name) {
        block("composite.attribute_name_required", "Every attribute needs a name.", "definition.attributes");
        break;
      }
      if (!attribute.dataType.trim()) {
        block("composite.attribute_type_required", `Attribute ${name} needs a data type.`, "definition.attributes");
        break;
      }
      if (seen.has(name)) {
        block("composite.duplicate_attribute", `Duplicate attribute name: ${name}`, "definition.attributes");
        break;
      }
      seen.add(name);
    }
    // Existing composites may be empty, including after dropping the last field.
    if (isCreate && definition.attributes.length === 0) {
      block("composite.no_attributes", "A composite type needs at least one attribute.", "definition.attributes");
    }
  }
  if (definition.kind === "domain") {
    if (!definition.baseType.trim()) block("domain.base_type_required", "A domain needs a base type.", "definition.baseType");
    const seen = new Set<string>();
    for (const constraint of definition.constraints) {
      const name = constraint.name;
      if (!name) {
        block("domain.constraint_name_required", "Every constraint needs a name.", "definition.constraints");
        break;
      }
      if (!constraint.expression.trim()) {
        block("domain.constraint_expression_required", `Constraint ${name} needs a CHECK expression.`, "definition.constraints");
        break;
      }
      if (seen.has(name)) {
        block("domain.duplicate_constraint", `Duplicate constraint name: ${name}`, "definition.constraints");
        break;
      }
      seen.add(name);
    }
  }
  // `none` has no fields; the planner decides whether the kind is creatable.
  if (definition.kind === "range" && isCreate && !definition.subtype.trim()) {
    block("range.subtype_required", "A range type needs a subtype.", "definition.subtype");
  }
  return issues;
}

/** JSON with keys sorted, so two structurally equal drafts compare equal. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

/** Drop empty new rows the user never filled in. */
export function pruneDraft(draft: CustomTypeDraft): CustomTypeDraft {
  const definition: CustomTypeDraftDefinition = draft.definition;
  if (definition.kind === "none") return draft;
  if (definition.kind === "enum") {
    return {
      ...draft,
      definition: {
        kind: "enum",
        // Whitespace is part of a PostgreSQL enum label. Only an untouched
        // empty new row is a placeholder; labels such as " " must reach SQL.
        values: definition.values.filter((entry) => entry.originalValue != null || entry.value !== ""),
      },
    };
  }
  if (definition.kind === "composite") {
    return {
      ...draft,
      definition: {
        kind: "composite",
        attributes: definition.attributes.filter((attribute) => attribute.originalName != null || attribute.name.trim() !== ""),
      },
    };
  }
  if (definition.kind === "domain") {
    return {
      ...draft,
      definition: {
        ...definition,
        constraints: definition.constraints.filter((constraint) => constraint.originalName != null || constraint.name.trim() !== "" || constraint.expression.trim() !== ""),
      },
    };
  }
  return draft;
}
