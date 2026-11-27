import { describe, expect, it } from "vitest";
import { CONNECTION_PICKER_OPTIONS, CONNECTION_PROFILES } from "@/types/generated/connectionProfiles";
import { connectionUrlPlaceholder } from "@/lib/connection/connectionPresentation";
import { h2FileJdbcUrlWithPath, parseH2JdbcUrl } from "@/lib/database/h2Connection";

describe("H2 connection dialog driver profiles", () => {
  it("keeps legacy profile hydration without exposing a second H2 catalog entry", () => {
    expect(CONNECTION_PROFILES["h2-legacy"]).toMatchObject({ type: "h2", port: 9092, user: "sa" });
    expect(CONNECTION_PICKER_OPTIONS.find((option) => option.value === "h2")?.category).toBe("lightweight");
    expect(CONNECTION_PICKER_OPTIONS.some((option) => option.value === "h2-legacy")).toBe(false);
  });

  it("provides H2 connection URL placeholders for TCP and file modes", () => {
    expect(connectionUrlPlaceholder("h2")).toBe("jdbc:h2:tcp://host:9092/database");
    expect(connectionUrlPlaceholder("h2", "file")).toBe("jdbc:h2:file:/path/to/database");
    expect(connectionUrlPlaceholder("h2", "h2")).toBe("jdbc:h2:tcp://host:9092/database");
  });
});

describe("H2 file URL construction", () => {
  it.each([undefined, "jdbc:h2:file:/old/db", "jdbc:h2:file:/old/db;"])("uses AUTO_SERVER for a file connection without options (%s)", (source) => {
    expect(h2FileJdbcUrlWithPath(source, "/new/db.mv.db")).toBe("jdbc:h2:file:/new/db;AUTO_SERVER=TRUE");
  });

  it("preserves an explicit AUTO_SERVER option", () => {
    expect(h2FileJdbcUrlWithPath("jdbc:h2:file:/old/db;auto_server=FALSE;DATABASE_TO_LOWER=TRUE", "/new/db.mv.db")).toBe("jdbc:h2:file:/new/db;auto_server=FALSE;DATABASE_TO_LOWER=TRUE");
  });

  it("keeps escaped option text and extracts credentials into separate fields", () => {
    const options = String.raw`SCHEMA=part\;PASSWORD=label;MODE=MySQL`;
    const source = String.raw`jdbc:h2:file:/old/db;${options};USER=sa;PASSWORD=one\;two`;
    expect(parseH2JdbcUrl(source)).toMatchObject({ username: "sa", password: "one;two", urlParams: options });
    expect(h2FileJdbcUrlWithPath(source, "/new/db.mv.db")).toBe(`jdbc:h2:file:/new/db;AUTO_SERVER=TRUE;${options}`);
  });

  it("preserves the split block size and options when replacing the path", () => {
    expect(h2FileJdbcUrlWithPath("jdbc:h2:split:28:/old/db;DATABASE_TO_LOWER=TRUE", "/new/db.mv.db")).toBe("jdbc:h2:split:28:/new/db;DATABASE_TO_LOWER=TRUE");
    expect(h2FileJdbcUrlWithPath("jdbc:h2:split:/old/db", "/new/db.mv.db")).toBe("jdbc:h2:split:/new/db");
  });
});
