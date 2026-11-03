import { describe, expect, it } from "vitest";
import { buildPostgresForeignTableOptions, restorePostgresForeignTableDraft, supportsPostgresForeignTableCreation } from "../postgresForeignTable";

describe("PostgreSQL foreign table creation", () => {
  it("limits the creation form to native PostgreSQL profiles", () => {
    expect(supportsPostgresForeignTableCreation({ db_type: "postgres" })).toBe(true);
    expect(supportsPostgresForeignTableCreation({ db_type: "postgres", driver_profile: " POSTGRES " })).toBe(true);
    expect(supportsPostgresForeignTableCreation({ db_type: "postgres", driver_profile: "redshift" })).toBe(false);
    expect(supportsPostgresForeignTableCreation({ db_type: "mysql" })).toBe(false);
    expect(supportsPostgresForeignTableCreation()).toBe(false);
  });

  it("preserves exact server names and option values for backend quoting", () => {
    expect(
      buildPostgresForeignTableOptions({
        enabled: true,
        server: 'server" name',
        options: [
          { name: " schema_name ", value: "remote's schema" },
          { name: "", value: "" },
          { name: "filename", value: " path with spaces " },
        ],
      }),
    ).toEqual({
      server: 'server" name',
      options: [
        { name: "schema_name", value: "remote's schema" },
        { name: "filename", value: " path with spaces " },
      ],
    });
  });

  it("keeps invalid partial options for authoritative validation and clones restored drafts", () => {
    const saved = { enabled: true, server: "remote", options: [{ name: "", value: "orphan value" }] };
    const draft = restorePostgresForeignTableDraft(saved);
    expect(buildPostgresForeignTableOptions(draft).options).toEqual(saved.options);
    draft.options[0]!.value = "changed";
    expect(saved.options[0]!.value).toBe("orphan value");
    expect(restorePostgresForeignTableDraft()).toEqual({ enabled: false, server: "", options: [] });
  });
});
