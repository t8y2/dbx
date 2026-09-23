import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("ConnectionDialog Xugu database requirement", () => {
  it("shows the existing required-database hint only for Xugu", () => {
    const placeholder = dialogSource.slice(dialogSource.indexOf("const databasePlaceholder = computed"), dialogSource.indexOf("const transportLayers"));
    expect(placeholder).toContain('if (form.value.db_type === "xugu") return t("connection.databasePlaceholderRequired")');
    expect(placeholder).toContain('if (form.value.db_type === "kingbase") return t("connection.databasePlaceholderRequired")');
  });

  it("validates Xugu's effective database before connection testing or saving", () => {
    const submit = dialogSource.slice(dialogSource.indexOf("function connectionConfigForSubmit"), dialogSource.indexOf("function ", dialogSource.indexOf("function connectionConfigForSubmit") + 10));
    expect(submit).toContain('if (config.db_type === "xugu")');
    expect(submit).toContain("hasXuguConnectionDatabase(config.database, config.connection_string)");
    expect(submit).toContain('throw new Error(t("connection.xuguDatabaseRequired"))');
    expect(submit).toContain('if (config.db_type === "kingbase")');
  });
});
