import { describe, expect, it } from "vitest";
import {
  buildSoqlCompletionItems,
  getSoqlCompletionContext,
  getSoqlCompletionResultValidFor,
  resolveSoqlFieldCandidates,
  resolveSoqlValueField,
  shouldAutoOpenSoqlCompletion,
  soqlCompletionNeedsFields,
  soqlCompletionNeedsObjects,
  type SoqlCompletionField,
  type SoqlCompletionObject,
} from "@/lib/soql/soqlCompletion";

const ACCOUNT_FIELDS: SoqlCompletionField[] = [
  { name: "Id", label: "Account ID", type: "id" },
  { name: "Name", label: "Account Name", type: "string" },
  { name: "OwnerId", label: "Owner ID", type: "reference", relationshipName: "Owner", referenceTo: ["User"] },
  { name: "ParentId", label: "Parent Account ID", type: "reference", relationshipName: "Parent", referenceTo: ["Account"] },
  { name: "Industry", label: "Industry", type: "picklist", picklistValues: ["Agriculture", "Banking", "Technology"] },
  { name: "IsActive", label: "Active", type: "boolean" },
  { name: "CreatedDate", label: "Created Date", type: "datetime" },
  { name: "AnnualRevenue", label: "Annual Revenue", type: "currency" },
];

const USER_FIELDS: SoqlCompletionField[] = [
  { name: "Id", type: "id" },
  { name: "Name", label: "Full Name", type: "string" },
  { name: "Email", label: "Email", type: "email" },
  { name: "ManagerId", type: "reference", relationshipName: "Manager", referenceTo: ["User"] },
];

const OBJECTS: SoqlCompletionObject[] = [
  { name: "Account", label: "Account" },
  { name: "Contact", label: "Contact" },
  { name: "Opportunity", label: "Opportunity" },
  { name: "MyObj__c", label: "My Object" },
];

function loader(map: Record<string, SoqlCompletionField[]>) {
  return async (objectName: string) => map[objectName] ?? [];
}

describe("getSoqlCompletionContext", () => {
  it("returns keyword mode for an empty statement", () => {
    const ctx = getSoqlCompletionContext("", 0);
    expect(ctx.mode).toBe("keyword");
    expect(ctx.clause).toBeNull();
  });

  it("classifies a partial leading keyword as keyword mode", () => {
    const text = "SEL";
    const ctx = getSoqlCompletionContext(text, text.length);
    expect(ctx.mode).toBe("keyword");
    expect(ctx.prefix).toBe("SEL");
  });

  it("resolves the FROM object and reports object mode after FROM", () => {
    const text = "SELECT Id FROM Acc";
    const ctx = getSoqlCompletionContext(text, text.length);
    expect(ctx.mode).toBe("object");
    expect(ctx.prefix).toBe("Acc");
    expect(ctx.clause).toBe("from");
  });

  it("reports field mode in SELECT and finds a FROM object written later", () => {
    const text = "SELECT Na FROM Account";
    const cursor = "SELECT Na".length;
    const ctx = getSoqlCompletionContext(text, cursor);
    expect(ctx.mode).toBe("field");
    expect(ctx.clause).toBe("select");
    expect(ctx.prefix).toBe("Na");
    expect(ctx.fromObject).toBe("Account");
    expect(ctx.relationshipPath).toEqual([]);
  });

  it("splits a relationship path into path + prefix", () => {
    const text = "SELECT Owner.Na FROM Account";
    const ctx = getSoqlCompletionContext(text, "SELECT Owner.Na".length);
    expect(ctx.mode).toBe("field");
    expect(ctx.relationshipPath).toEqual(["Owner"]);
    expect(ctx.prefix).toBe("Na");
    expect(ctx.from).toBe("SELECT Owner.".length);
  });

  it("detects value mode inside an open single-quoted string", () => {
    const text = "SELECT Id FROM Account WHERE Industry = 'Ban";
    const ctx = getSoqlCompletionContext(text, text.length);
    expect(ctx.mode).toBe("value");
    expect(ctx.insideString).toBe(true);
    expect(ctx.valueField).toEqual({ path: [], name: "Industry" });
    expect(ctx.prefix).toBe("Ban");
  });

  it("detects value mode after an operator without a quote yet", () => {
    const text = "SELECT Id FROM Account WHERE IsActive = ";
    const ctx = getSoqlCompletionContext(text, text.length);
    expect(ctx.mode).toBe("value");
    expect(ctx.insideString).toBeFalsy();
    expect(ctx.valueField).toEqual({ path: [], name: "IsActive" });
  });

  it("detects value mode on a relationship field path", () => {
    const text = "SELECT Id FROM Account WHERE Owner.Name = ";
    const ctx = getSoqlCompletionContext(text, text.length);
    expect(ctx.mode).toBe("value");
    expect(ctx.valueField).toEqual({ path: ["Owner"], name: "Name" });
  });

  it("does not treat a bare field in WHERE as a value", () => {
    const text = "SELECT Id FROM Account WHERE Ind";
    const ctx = getSoqlCompletionContext(text, text.length);
    expect(ctx.mode).toBe("field");
    expect(ctx.clause).toBe("where");
    expect(ctx.prefix).toBe("Ind");
  });

  it("reports orderby clause", () => {
    const text = "SELECT Id FROM Account ORDER BY Na";
    const ctx = getSoqlCompletionContext(text, text.length);
    expect(ctx.mode).toBe("field");
    expect(ctx.clause).toBe("orderby");
  });
});

describe("getSoqlCompletionContext statement boundaries", () => {
  it("does not inherit a value context from a completed statement", () => {
    // The previous statement's `> 1000` (unquoted literal) must not make the new
    // statement's `SELECT F|` a value context.
    const text = "SELECT Id FROM Account WHERE AnnualRevenue > 1000; SELECT F FROM Account";
    const cursor = "SELECT Id FROM Account WHERE AnnualRevenue > 1000; SELECT F".length;
    const ctx = getSoqlCompletionContext(text, cursor);
    expect(ctx.mode).toBe("field");
    expect(ctx.clause).toBe("select");
    expect(ctx.prefix).toBe("F");
    expect(ctx.fromObject).toBe("Account");
    expect(ctx.from).toBe(cursor - 1);
  });

  it("starts a fresh keyword context right after a semicolon", () => {
    const text = "SELECT Id FROM Account; SEL";
    const ctx = getSoqlCompletionContext(text, text.length);
    expect(ctx.mode).toBe("keyword");
    expect(ctx.prefix).toBe("SEL");
    expect(ctx.from).toBe("SELECT Id FROM Account; ".length);
  });

  it("scopes FROM detection to the current statement", () => {
    const text = "SELECT Id FROM Contact; SELECT Na FROM Account";
    const cursor = "SELECT Id FROM Contact; SELECT Na".length;
    const ctx = getSoqlCompletionContext(text, cursor);
    expect(ctx.mode).toBe("field");
    expect(ctx.fromObject).toBe("Account");
  });

  it("does not borrow the previous statement's FROM when the current one has none yet", () => {
    const text = "SELECT Id FROM Contact; SELECT Na";
    const ctx = getSoqlCompletionContext(text, text.length);
    expect(ctx.mode).toBe("field");
    expect(ctx.fromObject).toBeUndefined();
  });

  it("keeps absolute from positions for value mode inside a later statement's string", () => {
    const text = "SELECT Id FROM Account; SELECT Id FROM Opportunity WHERE StageName = 'Clo";
    const ctx = getSoqlCompletionContext(text, text.length);
    expect(ctx.mode).toBe("value");
    expect(ctx.insideString).toBe(true);
    expect(ctx.from).toBe(text.indexOf("'Clo") + 1);
    expect(ctx.valueField).toEqual({ path: [], name: "StageName" });
    expect(ctx.fromObject).toBe("Opportunity");
  });
});

describe("resolveSoqlFieldCandidates", () => {
  const load = loader({ Account: ACCOUNT_FIELDS, User: USER_FIELDS });

  it("returns base object fields with no relationship path", async () => {
    const ctx = getSoqlCompletionContext("SELECT  FROM Account", "SELECT ".length);
    const fields = await resolveSoqlFieldCandidates(ctx, load);
    expect(fields).toEqual(ACCOUNT_FIELDS);
  });

  it("traverses a single relationship segment", async () => {
    const ctx = getSoqlCompletionContext("SELECT Owner. FROM Account", "SELECT Owner.".length);
    const fields = await resolveSoqlFieldCandidates(ctx, load);
    expect(fields).toEqual(USER_FIELDS);
  });

  it("traverses a multi-segment relationship path", async () => {
    const ctx = getSoqlCompletionContext("SELECT Owner.Manager. FROM Account", "SELECT Owner.Manager.".length);
    const fields = await resolveSoqlFieldCandidates(ctx, load);
    expect(fields).toEqual(USER_FIELDS);
  });

  it("returns empty when a path segment is not a relationship", async () => {
    const ctx = getSoqlCompletionContext("SELECT Name. FROM Account", "SELECT Name.".length);
    const fields = await resolveSoqlFieldCandidates(ctx, load);
    expect(fields).toEqual([]);
  });

  it("returns empty when there is no FROM object", async () => {
    const ctx = getSoqlCompletionContext("SELECT ", "SELECT ".length);
    const fields = await resolveSoqlFieldCandidates(ctx, load);
    expect(fields).toEqual([]);
  });
});

describe("resolveSoqlValueField", () => {
  const load = loader({ Account: ACCOUNT_FIELDS, User: USER_FIELDS });

  it("resolves a direct field for value completion", async () => {
    const ctx = getSoqlCompletionContext("SELECT Id FROM Account WHERE Industry = '", "SELECT Id FROM Account WHERE Industry = '".length);
    const field = await resolveSoqlValueField(ctx, load);
    expect(field?.name).toBe("Industry");
    expect(field?.picklistValues).toContain("Banking");
  });

  it("resolves a field across a relationship path", async () => {
    const ctx = getSoqlCompletionContext("SELECT Id FROM Account WHERE Owner.Email = '", "SELECT Id FROM Account WHERE Owner.Email = '".length);
    const field = await resolveSoqlValueField(ctx, load);
    expect(field?.name).toBe("Email");
  });
});

describe("buildSoqlCompletionItems", () => {
  it("offers clause keywords in keyword mode", () => {
    const ctx = getSoqlCompletionContext("SEL", 3);
    const items = buildSoqlCompletionItems(ctx, {});
    expect(items.map((i) => i.label)).toContain("SELECT");
  });

  it("offers objects in object mode, standard before custom", () => {
    const ctx = getSoqlCompletionContext("SELECT Id FROM ", "SELECT Id FROM ".length);
    const items = buildSoqlCompletionItems(ctx, { objects: OBJECTS });
    expect(items.map((i) => i.label)).toEqual(["Account", "Contact", "Opportunity", "MyObj__c"]);
    expect(items[0].type).toBe("table");
  });

  it("offers fields and marks reference fields as traversal with a trailing dot", () => {
    const ctx = getSoqlCompletionContext("SELECT  FROM Account", "SELECT ".length);
    const items = buildSoqlCompletionItems(ctx, { fields: ACCOUNT_FIELDS });
    const owner = items.find((i) => i.label === "OwnerId");
    expect(owner?.type).toBe("property");
    expect(owner?.apply).toBe("Owner.");
    const name = items.find((i) => i.label === "Name");
    expect(name?.type).toBe("column");
    expect(name?.apply).toBe("Name");
  });

  it("offers aggregate functions and FIELDS selectors in SELECT", () => {
    const ctx = getSoqlCompletionContext("SELECT  FROM Account", "SELECT ".length);
    const items = buildSoqlCompletionItems(ctx, { fields: ACCOUNT_FIELDS });
    const labels = items.map((i) => i.label);
    expect(labels).toContain("COUNT");
    expect(labels).toContain("FIELDS(ALL)");
  });

  it("offers picklist values (quoted) for a picklist value context outside a string", () => {
    const ctx = getSoqlCompletionContext("SELECT Id FROM Account WHERE Industry = ", "SELECT Id FROM Account WHERE Industry = ".length);
    const field = ACCOUNT_FIELDS.find((f) => f.name === "Industry")!;
    const items = buildSoqlCompletionItems(ctx, { valueField: field });
    const banking = items.find((i) => i.label === "Banking");
    expect(banking?.apply).toBe("'Banking'");
  });

  it("inserts bare picklist values and consumes the closing quote inside a string", () => {
    const text = "SELECT Id FROM Account WHERE Industry = '";
    const ctx = getSoqlCompletionContext(text, text.length);
    const field = ACCOUNT_FIELDS.find((f) => f.name === "Industry")!;
    const items = buildSoqlCompletionItems(ctx, { valueField: field });
    const banking = items.find((i) => i.label === "Banking");
    expect(banking?.apply).toBe("Banking");
    expect(banking?.replaceClosingQuote).toBe("'");
  });

  it("offers TRUE/FALSE for a boolean field and date literals for datetime", () => {
    const boolCtx = getSoqlCompletionContext("SELECT Id FROM Account WHERE IsActive = ", "SELECT Id FROM Account WHERE IsActive = ".length);
    const boolField = ACCOUNT_FIELDS.find((f) => f.name === "IsActive")!;
    expect(buildSoqlCompletionItems(boolCtx, { valueField: boolField }).map((i) => i.label)).toContain("TRUE");

    const dateCtx = getSoqlCompletionContext("SELECT Id FROM Account WHERE CreatedDate > ", "SELECT Id FROM Account WHERE CreatedDate > ".length);
    const dateField = ACCOUNT_FIELDS.find((f) => f.name === "CreatedDate")!;
    const dateLabels = buildSoqlCompletionItems(dateCtx, { valueField: dateField }).map((i) => i.label);
    expect(dateLabels).toContain("TODAY");
    expect(dateLabels).toContain("LAST_N_DAYS:n");
  });

  it("filters by prefix case-insensitively on name and label", () => {
    const ctx = getSoqlCompletionContext("SELECT ann FROM Account", "SELECT ann".length);
    const items = buildSoqlCompletionItems(ctx, { fields: ACCOUNT_FIELDS });
    // "ann" matches AnnualRevenue by name prefix (case-insensitive)
    expect(items.map((i) => i.label)).toContain("AnnualRevenue");
  });
});

describe("mode predicates and helpers", () => {
  it("routes object vs field metadata needs", () => {
    expect(soqlCompletionNeedsObjects("object")).toBe(true);
    expect(soqlCompletionNeedsObjects("field")).toBe(false);
    expect(soqlCompletionNeedsFields("field")).toBe(true);
    expect(soqlCompletionNeedsFields("value")).toBe(true);
    expect(soqlCompletionNeedsFields("keyword")).toBe(false);
  });

  it("auto-opens on relationship dot, quote, and identifier typing", () => {
    expect(shouldAutoOpenSoqlCompletion("SELECT Owner.", "SELECT Owner.".length)).toBe(true);
    expect(shouldAutoOpenSoqlCompletion("SELECT Id FROM Account WHERE Industry = '", "SELECT Id FROM Account WHERE Industry = '".length)).toBe(true);
    expect(shouldAutoOpenSoqlCompletion("SELECT Na", "SELECT Na".length)).toBe(true);
    expect(shouldAutoOpenSoqlCompletion("", 0)).toBe(false);
  });

  it("gives a value-mode validFor that stops at a quote", () => {
    const text = "SELECT Id FROM Account WHERE Industry = 'Ban";
    const ctx = getSoqlCompletionContext(text, text.length);
    const re = getSoqlCompletionResultValidFor(ctx);
    expect(re.test("Ban")).toBe(true);
    expect(re.test("Ban'")).toBe(false);
  });
});
