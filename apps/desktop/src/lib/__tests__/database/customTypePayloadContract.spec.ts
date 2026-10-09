// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { draftFromDetails, emptyDraft } from "@/lib/database/customTypeDraft";
import type { ApplyCustomTypeChangeRequest, ApplyCustomTypeDropRequest, CustomTypeChangeRequest, CustomTypeDetails, CustomTypeDraft, CustomTypeKind, CustomTypeDropRequest } from "@/types/database";

/**
 * The other half of `crates/dbx-core/tests/custom_type_payload_contract.rs`.
 *
 * Both tests read one fixture: this side proves the frontend produces the
 * fixture's camelCase objects, and the Rust side proves those same bytes
 * deserialize into the command arguments. A field-name drift therefore fails in
 * CI instead of showing up as `missing field base_type` in SQL preview.
 */

interface DraftCase {
  name: string;
  target: CustomTypeChangeRequest["target"];
  details?: CustomTypeDetails;
  emptyDraft?: { kind: CustomTypeKind; schema: string };
  draft: CustomTypeDraft;
}

interface ContractFixture {
  draftCases: DraftCase[];
  createDrafts: Array<{ kind: CustomTypeKind; draft: CustomTypeDraft }>;
  applyRequests: Array<{ name: string; apply: ApplyCustomTypeChangeRequest }>;
  dropRequests: Array<{ name: string; request: CustomTypeDropRequest; apply: ApplyCustomTypeDropRequest }>;
}

const fixture = JSON.parse(readFileSync(new URL("../../../../../../tests/fixtures/custom-type-payload-contract.json", import.meta.url), "utf8")) as ContractFixture;

describe("custom type payload contract", () => {
  it("builds every edit draft in the shared camelCase shape", () => {
    for (const entry of fixture.draftCases) {
      if (!entry.details) continue;
      expect(draftFromDetails(entry.details), entry.name).toEqual(entry.draft);
      const request: CustomTypeChangeRequest = { target: entry.target, expectedSnapshotRevision: entry.details.snapshotRevision, draft: draftFromDetails(entry.details) };
      expect(request, entry.name).toEqual({ target: entry.target, expectedSnapshotRevision: "snapshot-1", draft: entry.draft });
    }
  });

  it("builds every new-type draft in the shared camelCase shape", () => {
    for (const entry of fixture.createDrafts) {
      expect(emptyDraft(entry.kind, entry.draft.schema), entry.kind).toEqual(entry.draft);
    }
  });

  it("pins the multi-word fields that previously drifted", () => {
    const domain = fixture.draftCases.find((entry) => entry.name === "edit-domain")!.draft.definition;
    expect(domain).toMatchObject({
      kind: "domain",
      baseType: "text",
      notNull: true,
    });
    expect(domain).not.toHaveProperty("base_type");
    expect(domain).not.toHaveProperty("not_null");

    const range = fixture.draftCases.find((entry) => entry.name === "edit-range")!.draft.definition;
    expect(range).toMatchObject({
      kind: "range",
      subtypeOpclass: "pg_catalog.numeric_ops",
      multirangeName: "price_multirange",
    });
    expect(range).not.toHaveProperty("subtype_opclass");
    expect(range).not.toHaveProperty("multirange_name");

    const base = fixture.draftCases.find((entry) => entry.name === "edit-base")!.draft.definition;
    expect(base).toEqual({ kind: "none", typeKind: "base" });
    expect(base).not.toHaveProperty("type_kind");
  });

  it("keeps apply and drop wrappers camelCase", () => {
    expect(fixture.applyRequests[0]!.apply).toHaveProperty("expectedPlanRevision", "rev-1");
    expect(fixture.applyRequests[0]!.apply).not.toHaveProperty("expected_plan_revision");
    expect(fixture.dropRequests[0]!.apply).toHaveProperty("expectedPlanRevision", "drop-rev-1");
    expect(fixture.dropRequests[0]!.request).toEqual({
      target: { schema: "app", name: "status", kind: "enum" },
      cascade: false,
    });
  });
});
