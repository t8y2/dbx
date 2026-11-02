import { describe, expect, it } from "vitest";
import { patchConnectionParameter } from "./connectionParameterDocument";
import { setMysqlDataCharset } from "./mysqlDataCharset";
import { withOracleLegacyCharset } from "./oracleLegacyCharset";
import { setMysqlCleartextPasswordAuthEnabled } from "../database/mysqlConnectionOptions";

describe("existing connection controls preserve parameter-editor documents", () => {
  const source = "?localInfilePath=%2ftmp%2fa.csv&localInfilePath=/tmp/b.csv&unknown=%FF&flag&empty=&plus=a+b";
  it("patches only a selected key, retaining opaque and repeated parameters", () => {
    expect(patchConnectionParameter(source, "ssl-mode", "required")).toBe(source + "&ssl-mode=required");
    expect(patchConnectionParameter(source + "&ssl-mode=disabled", "ssl-mode", "required")).toBe(source + "&ssl-mode=required");
  });
  it("removes only an explicitly reset parameter", () => {
    expect(patchConnectionParameter(source + "&ssl-mode=required", "ssl-mode", null)).toBe(source);
  });
  it("replaces an explicitly edited opaque value without normalizing its neighbors", () => {
    expect(patchConnectionParameter("x=%2f&charset=%FF&y=a+b", "charset", "utf8mb4")).toBe("x=%2f&y=a+b&charset=utf8mb4");
  });
  it("keeps original bytes through MySQL charset controls", () => {
    const enabled = setMysqlDataCharset(source, "GBK");
    expect(enabled).toBe(source + "&dataCharset=GBK");
    expect(setMysqlDataCharset(enabled, "default")).toBe(source);
  });
  it("keeps original bytes through Oracle compatibility controls", () => {
    const enabled = withOracleLegacyCharset(source, "ZHS16GBK");
    expect(enabled).toBe(source + "&DBX_LEGACY_CHARSET=ZHS16GBK");
    expect(withOracleLegacyCharset(enabled, "")).toBe(source);
  });
  it("keeps original bytes through authentication controls and collapses only targeted aliases", () => {
    const enabled = setMysqlCleartextPasswordAuthEnabled(source + "&allowCleartextPasswords=false&enable_cleartext_plugin=false", true);
    expect(enabled).toBe(source + "&enable_cleartext_plugin=true");
    expect(setMysqlCleartextPasswordAuthEnabled(enabled, false)).toBe(source);
  });
  it("does not rewrite equivalent percent encodings for a no-op control update", () => {
    expect(patchConnectionParameter("charset=%75tf8mb4&unknown=%2f", "charset", "utf8mb4")).toBe("charset=%75tf8mb4&unknown=%2f");
  });
});
