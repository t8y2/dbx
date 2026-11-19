// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { alignPlDebugSourceLines, loadPlDebugObjectSource } from "@/lib/debug/plDebugSourceAlignment";
import type { ObjectSource } from "@/types/database";

/**
 * The exact shapes measured against DBX_DEBUG.DBX_T_PKG on Oracle 19c EE (2026-10-13):
 * `get_object_source` for a PACKAGE_BODY answers GET_DDL text whose first line is empty
 * (15 lines), while DBMS_DEBUG reports ALL_SOURCE line numbers (14 lines, line 1 = the
 * `PACKAGE BODY` header). Every debug line therefore landed one line too high.
 */
const GET_DDL_PACKAGE_BODY = [
  "",
  '  CREATE OR REPLACE EDITIONABLE PACKAGE BODY "DBX_DEBUG"."DBX_T_PKG" AS',
  "  PROCEDURE RUN_TASK(P_N IN NUMBER) AS",
  "    V_TOTAL NUMBER := 0;",
  "  BEGIN",
  "    FOR i IN 1..P_N LOOP",
  "      V_TOTAL := V_TOTAL + i;",
  "    END LOOP;",
  "  END RUN_TASK;",
  "END DBX_T_PKG;",
].join("\n");

const ALL_SOURCE_PACKAGE_BODY = ["PACKAGE BODY DBX_T_PKG AS", "  PROCEDURE RUN_TASK(P_N IN NUMBER) AS", "    V_TOTAL NUMBER := 0;", "  BEGIN", "    FOR i IN 1..P_N LOOP", "      V_TOTAL := V_TOTAL + i;", "    END LOOP;", "  END RUN_TASK;", "END DBX_T_PKG;"].join("\n");

describe("alignPlDebugSourceLines", () => {
  it("drops the leading blank line GET_DDL adds before the CREATE header", () => {
    const aligned = alignPlDebugSourceLines(GET_DDL_PACKAGE_BODY).split("\n");
    const allSource = ALL_SOURCE_PACKAGE_BODY.split("\n");

    expect(aligned).toHaveLength(allSource.length);
    expect(aligned[0]).toBe('  CREATE OR REPLACE EDITIONABLE PACKAGE BODY "DBX_DEBUG"."DBX_T_PKG" AS');
    // Below the CREATE header the two texts are line-for-line identical, so a
    // DBMS_DEBUG line number (ALL_SOURCE numbering) now names the right editor line:
    // ALL_SOURCE line 2 is `PROCEDURE RUN_TASK...`, and so is editor line 2.
    expect(aligned[1]).toBe(allSource[1]);
    expect(aligned[2]).toBe(allSource[2]);
  });

  it("leaves ALL_SOURCE-shaped text (standalone routines) untouched", () => {
    const source = "PROCEDURE DBX_T_PROC IS\n  N NUMBER := 0;\nBEGIN\n  NULL;\nEND;";

    expect(alignPlDebugSourceLines(source)).toBe(source);
  });

  it("strips several blank lines and CRLF blank lines", () => {
    expect(alignPlDebugSourceLines("\r\n\r\n  PACKAGE BODY X AS")).toBe("  PACKAGE BODY X AS");
    expect(alignPlDebugSourceLines("\n   \nPACKAGE BODY X AS")).toBe("PACKAGE BODY X AS");
  });

  it("keeps an anonymous block's own first line (it starts with text)", () => {
    const source = "DECLARE\n  V NUMBER;\nBEGIN\n  NULL;\nEND;";

    expect(alignPlDebugSourceLines(source)).toBe(source);
  });
});

describe("loadPlDebugObjectSource", () => {
  it("aligns the package body it loaded and keeps the fallback's object type", async () => {
    const getObjectSource = vi.fn(async () => ({ name: "DBX_T_PKG", object_type: "PACKAGE_BODY", schema: "DBX_DEBUG", source: GET_DDL_PACKAGE_BODY }) as ObjectSource);

    const loaded = await loadPlDebugObjectSource(getObjectSource, "c1", "dbatest", "DBX_DEBUG", "DBX_T_PKG", "PACKAGE_BODY");

    expect(loaded.objectType).toBe("PACKAGE_BODY");
    expect(loaded.source.source?.split("\n")[1]).toBe("  PROCEDURE RUN_TASK(P_N IN NUMBER) AS");
  });

  it("passes a standalone routine through untouched", async () => {
    const source = "PROCEDURE P_DEMO IS\nBEGIN\n  NULL;\nEND;";
    const getObjectSource = vi.fn(async () => ({ name: "P_DEMO", object_type: "PROCEDURE", schema: "S", source }) as ObjectSource);

    const loaded = await loadPlDebugObjectSource(getObjectSource, "c1", "ob", "S", "P_DEMO", "PROCEDURE");

    expect(loaded.source.source).toBe(source);
  });
});
