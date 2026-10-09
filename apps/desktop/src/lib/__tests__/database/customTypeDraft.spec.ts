import { describe, expect, it } from "vitest";
import { CREATABLE_KINDS, draftFromDetails, draftIsDirty, draftValidationIssues, emptyDraft, kindHasStructuralEditor, operationForCreateKind, pruneDraft, supportsOperation } from "@/lib/database/customTypeDraft";
import type { CustomTypeDetails, CustomTypeDraft, CustomTypeManagementCapabilities } from "@/types/database";

function capabilities(overrides: Record<string, boolean> = {}): CustomTypeManagementCapabilities {
  const operations: CustomTypeManagementCapabilities["operations"] = {};
  for (const key of ["alter.enum.addValue", "alter.enum.renameValue", "create.enum", "drop.restrict"]) {
    operations[key as keyof typeof operations] = { supported: overrides[key] !== false };
  }
  return {
    databaseType: "postgres",
    productVersion: "16.0",
    compatibilityMode: null,
    operations,
    capabilityRevision: "cap-1",
  };
}

function enumDetails(overrides: Partial<CustomTypeDetails> = {}): CustomTypeDetails {
  return {
    name: "status",
    schema: "app",
    kind: "enum",
    comment: "order status",
    owner: "app_owner",
    members: [
      { name: "", dataType: "", ordinal: 1, enumValue: "draft" },
      { name: "", dataType: "", ordinal: 2, enumValue: "published" },
    ],
    properties: { domainConstraints: [] },
    ddl: null,
    ...overrides,
  };
}

function compositeDetails(): CustomTypeDetails {
  return enumDetails({
    name: "address",
    kind: "composite",
    comment: null,
    owner: null,
    members: [
      { name: "city", dataType: "text", ordinal: 1, comment: "city name" },
      { name: "zip", dataType: "numeric(6)", ordinal: 2 },
    ],
  });
}

function domainDetails(): CustomTypeDetails {
  return enumDetails({
    name: "email",
    kind: "domain",
    comment: null,
    members: [],
    properties: {
      baseType: "text",
      collation: "C",
      default: "''::text",
      notNull: true,
      domainConstraints: [{ name: "email_valid", definition: "CHECK ((VALUE <> ''::text))", validated: false }],
    },
  });
}

function rangeDetails(): CustomTypeDetails {
  return enumDetails({
    name: "price_range",
    kind: "range",
    comment: null,
    members: [],
    properties: { rangeSubtype: "numeric", rangeSubtypeOpclass: "pg_catalog.numeric_ops", rangeMultirangeName: "price_multirange", domainConstraints: [] },
  });
}

describe("customTypeDraft", () => {
  it("maps each creatable kind to its capability id", () => {
    expect(CREATABLE_KINDS).toEqual(["enum", "composite", "domain", "range"]);
    expect(operationForCreateKind("enum")).toBe("create.enum");
    expect(operationForCreateKind("base")).toBeNull();
    expect(operationForCreateKind("multirange")).toBeNull();
  });

  it("reports operation support only when the backend says so", () => {
    expect(supportsOperation(capabilities(), "alter.enum.addValue")).toBe(true);
    expect(supportsOperation(capabilities({ "alter.enum.renameValue": false }), "alter.enum.renameValue")).toBe(false);
    expect(supportsOperation(null, "alter.enum.addValue")).toBe(false);
    // An operation absent from the payload is not implicitly supported.
    expect(supportsOperation(capabilities(), "alter.domain.renameConstraint")).toBe(false);
  });

  it("gives every creatable kind a non-empty starting draft", () => {
    for (const kind of CREATABLE_KINDS) {
      const draft = emptyDraft(kind, "app");
      expect(draft.schema).toBe("app");
      expect(draft.definition.kind).toBe(kind);
      // A composite cannot be created empty, so the form starts with one row.
      if (kind === "composite") {
        expect(draft.definition).toMatchObject({ attributes: [{ name: "", dataType: "text" }] });
      }
    }
  });

  it("marks types with a structural editor", () => {
    expect(kindHasStructuralEditor("composite")).toBe(true);
    expect(kindHasStructuralEditor("base")).toBe(false);
    expect(kindHasStructuralEditor("multirange")).toBe(false);
  });

  it("keeps catalog identity when building a draft from details", () => {
    const draft = draftFromDetails(compositeDetails());
    expect(draft.definition).toEqual({
      kind: "composite",
      attributes: [
        { name: "city", originalName: "city", dataType: "text", comment: "city name" },
        { name: "zip", originalName: "zip", dataType: "numeric(6)", comment: null },
      ],
    });
    expect(draft.owner).toBeNull();
  });

  it("carries enum values, domain constraints and range properties verbatim", () => {
    expect(draftFromDetails(enumDetails()).definition).toEqual({
      kind: "enum",
      values: [
        { value: "draft", originalValue: "draft" },
        { value: "published", originalValue: "published" },
      ],
    });
    expect(draftFromDetails(domainDetails()).definition).toEqual({
      kind: "domain",
      baseType: "text",
      collation: "C",
      default: "''::text",
      notNull: true,
      constraints: [{ name: "email_valid", originalName: "email_valid", expression: "CHECK ((VALUE <> ''::text))", validated: false }],
    });
    expect(draftFromDetails(rangeDetails()).definition).toEqual({
      kind: "range",
      subtype: "numeric",
      subtypeOpclass: "pg_catalog.numeric_ops",
      canonicalFunction: null,
      subtypeDiffFunction: null,
      multirangeName: "price_multirange",
    });
  });

  it("never treats an untouched draft as dirty", () => {
    const details = compositeDetails();
    const original = draftFromDetails(details);
    const current = draftFromDetails(details);
    expect(draftIsDirty(original, current)).toBe(false);

    const renamed = draftFromDetails(details);
    if (renamed.definition.kind !== "composite") throw new Error("unexpected kind");
    renamed.definition.attributes[0]!.name = "town";
    expect(draftIsDirty(original, renamed)).toBe(true);
  });

  it("treats a cleared comment as a change", () => {
    const original = draftFromDetails(enumDetails());
    const cleared: CustomTypeDraft = { ...original, comment: null };
    expect(draftIsDirty(original, cleared)).toBe(true);
  });

  it("validates identity and enum uniqueness locally", () => {
    const draft = emptyDraft("enum", "");
    draft.name = "  ";
    if (draft.definition.kind === "enum") {
      draft.definition.values = [
        { value: "draft", originalValue: null },
        { value: "draft", originalValue: null },
      ];
    }
    const codes = draftValidationIssues(draft, true).map((issue) => issue.code);
    expect(codes).toContain("identity.schema_required");
    expect(codes).toContain("identity.name_required");
    expect(codes).toContain("enum.duplicate_value");
  });

  it("allows generic edits of an existing empty composite and dropping its last attribute", () => {
    const empty = draftFromDetails({ ...compositeDetails(), members: [] });
    empty.comment = "empty record";
    expect(draftValidationIssues(empty, false)).toEqual([]);

    const emptied = draftFromDetails(compositeDetails());
    if (emptied.definition.kind !== "composite") throw new Error("unexpected kind");
    emptied.definition.attributes = [];
    expect(draftValidationIssues(emptied, false)).toEqual([]);
  });

  it("requires the fields a create cannot omit", () => {
    const composite = emptyDraft("composite", "app");
    composite.name = "address";
    if (composite.definition.kind === "composite") composite.definition.attributes = [];
    expect(draftValidationIssues(composite, true).map((issue) => issue.code)).toContain("composite.no_attributes");

    const domain = emptyDraft("domain", "app");
    domain.name = "email";
    if (domain.definition.kind === "domain") domain.definition.baseType = "";
    expect(draftValidationIssues(domain, true).map((issue) => issue.code)).toContain("domain.base_type_required");

    const range = emptyDraft("range", "app");
    range.name = "price_range";
    expect(draftValidationIssues(range, true).map((issue) => issue.code)).toContain("range.subtype_required");
  });

  it("checks constraint names and expressions", () => {
    const draft = emptyDraft("domain", "app");
    draft.name = "email";
    if (draft.definition.kind === "domain") {
      draft.definition.constraints = [
        { name: "c1", originalName: null, expression: "" },
        { name: "c1", originalName: null, expression: "VALUE <> ''" },
      ];
    }
    const codes = draftValidationIssues(draft, true).map((issue) => issue.code);
    expect(codes).toContain("domain.constraint_expression_required");
  });

  it("drops blank rows the user never filled in, but keeps existing ones", () => {
    const draft = emptyDraft("composite", "app");
    if (draft.definition.kind === "composite") {
      draft.definition.attributes = [
        { name: "city", originalName: "city", dataType: "text", comment: null },
        { name: "", originalName: null, dataType: "text", comment: null },
      ];
    }
    const pruned = pruneDraft(draft);
    expect(pruned.definition).toMatchObject({ attributes: [{ name: "city", originalName: "city" }] });
  });

  it("does not prune an existing row whose name was cleared by mistake", () => {
    // Losing an existing attribute because a field was momentarily empty would
    // be far worse than sending it and letting the planner explain.
    const draft = emptyDraft("enum", "app");
    if (draft.definition.kind === "enum") {
      draft.definition.values = [
        { value: "", originalValue: "draft" },
        { value: "", originalValue: null },
      ];
    }
    const pruned = pruneDraft(draft);
    expect(pruned.definition).toMatchObject({ values: [{ value: "", originalValue: "draft" }] });
  });

  it.each(["create", "edit"])("preserves whitespace enum labels in a %s request", (mode) => {
    const isCreate = mode === "create";
    const values = [
      { value: "ready", originalValue: isCreate ? null : "ready" },
      { value: " ", originalValue: null },
      { value: "\t", originalValue: null },
      { value: "  ready  ", originalValue: null },
    ];
    const draft: CustomTypeDraft = {
      ...emptyDraft("enum", "app"),
      name: "status",
      definition: { kind: "enum", values: [...values, { value: "", originalValue: null }] },
    };
    expect(draftValidationIssues(draft, isCreate)).toEqual([]);
    expect(pruneDraft(draft).definition).toEqual({ kind: "enum", values });
  });
});
