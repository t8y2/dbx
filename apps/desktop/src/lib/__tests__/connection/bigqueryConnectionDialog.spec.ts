import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("BigQuery connection dialog", () => {
  it("exposes and persists external JDBC driver configuration", () => {
    const nativeAgentDriverSupport = dialogSource.match(/function supportsNativeAgentJdbcDriverConfigType\(dbType: DatabaseType\): boolean \{([\s\S]*?)\}/)?.[1] ?? "";
    const jdbcBackedDatabaseTypes = dialogSource.match(/const jdbcBackedDatabaseTypes = new Set<DatabaseType>\(\[([\s\S]*?)\]\);/)?.[1] ?? "";

    expect(nativeAgentDriverSupport).toContain('dbType === "bigquery"');
    expect(jdbcBackedDatabaseTypes).toContain('"bigquery"');
    expect(dialogSource).toContain("const supportsNativeAgentJdbcDriverConfig = computed(() => supportsNativeAgentJdbcDriverConfigType(form.value.db_type));");
    expect(dialogSource).toContain('<template v-if="supportsNativeAgentJdbcDriverConfig">');
    expect(dialogSource).toContain('if (profile.type === "bigquery") {');
    expect(dialogSource).toContain("jdbcManualClasspathOpen.value = true;");
  });
});
