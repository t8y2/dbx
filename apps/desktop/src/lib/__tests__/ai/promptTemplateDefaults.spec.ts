import { describe, expect, it } from "vitest";

import { capTemplateIdsToCharLimit, resolveAutoTemplateIds, resolveDefaultTemplateIds } from "@/lib/ai/promptTemplateDefaults";
import type { PromptTemplate } from "@/types/promptTemplate";

function template(id: string, content: string): PromptTemplate {
  return { id, name: id, content, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
}

describe("resolveDefaultTemplateIds", () => {
  it("returns the configured defaults for the db_type", () => {
    expect(resolveDefaultTemplateIds("postgresql", { postgresql: ["tpl-pg"] })).toEqual(["tpl-pg"]);
  });

  it("returns empty when no defaults are configured", () => {
    // Namespace-switch contract: with no defaults the switch clears the
    // selection; last-used is unreachable from this resolution by design.
    expect(resolveDefaultTemplateIds("postgresql", {})).toEqual([]);
    expect(resolveDefaultTemplateIds("postgresql", { mysql: ["tpl-my"] })).toEqual([]);
  });

  it("resolves nothing without a connection db_type", () => {
    expect(resolveDefaultTemplateIds(undefined, { mysql: ["tpl"] })).toEqual([]);
  });
});

describe("resolveAutoTemplateIds", () => {
  it("returns explicit defaults for the connection db_type", () => {
    expect(
      resolveAutoTemplateIds({
        dbType: "postgresql",
        defaultTemplatesByDbType: { postgresql: ["tpl-pg"] },
        lastUsedTemplatesByDbType: { postgresql: ["tpl-last"] },
      }),
    ).toEqual(["tpl-pg"]);
  });

  it("falls back to the db_type's last-used templates only when no defaults are configured", () => {
    expect(
      resolveAutoTemplateIds({
        dbType: "mysql",
        defaultTemplatesByDbType: { postgresql: ["tpl-pg"] },
        lastUsedTemplatesByDbType: { mysql: ["tpl-last"] },
      }),
    ).toEqual(["tpl-last"]);
  });

  it("never leaks another db_type's defaults or last-used list", () => {
    expect(
      resolveAutoTemplateIds({
        dbType: "mysql",
        defaultTemplatesByDbType: { postgresql: ["tpl-pg"] },
        lastUsedTemplatesByDbType: { postgresql: ["tpl-last"] },
      }),
    ).toEqual([]);
  });

  it("treats an empty defaults list as unconfigured and still applies last-used", () => {
    expect(
      resolveAutoTemplateIds({
        dbType: "mysql",
        defaultTemplatesByDbType: { mysql: [] },
        lastUsedTemplatesByDbType: { mysql: ["tpl-last"] },
      }),
    ).toEqual(["tpl-last"]);
  });

  it("resolves nothing without a connection db_type", () => {
    expect(resolveAutoTemplateIds({ defaultTemplatesByDbType: { mysql: ["tpl"] }, lastUsedTemplatesByDbType: {} })).toEqual([]);
  });
});

describe("capTemplateIdsToCharLimit", () => {
  it("drops ids whose templates no longer exist", () => {
    const templates = [template("kept", "abc")];
    expect(capTemplateIdsToCharLimit(["missing", "kept"], templates, 100)).toEqual(["kept"]);
  });

  it("skips a template that alone exceeds the remaining budget but keeps later smaller ones", () => {
    const templates = [template("small-a", "abc"), template("huge", "x".repeat(10)), template("small-b", "de")];
    expect(capTemplateIdsToCharLimit(["small-a", "huge", "small-b"], templates, 8)).toEqual(["small-a", "small-b"]);
  });

  it("deduplicates repeated ids without double counting their content", () => {
    const templates = [template("a", "abc")];
    expect(capTemplateIdsToCharLimit(["a", "a"], templates, 5)).toEqual(["a"]);
  });
});
