import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");
const fieldsSource = readFileSync(new URL("../../../components/connection/SpannerConnectionFields.vue", import.meta.url), "utf8");

describe("Cloud Spanner connection dialog", () => {
  it("registers the bundled agent profile in the SQL category", () => {
    expect(dialogSource).toContain('spanner: { type: "spanner", port: 443, user: "", label: "Cloud Spanner", icon: "spanner" }');
    expect(dialogSource).toContain('{ value: "spanner", label: "Cloud Spanner" }');
    expect(dialogSource).toContain('spanner: "spanner",');

    // Cloud Spanner is an OLTP relational database, so it belongs to the SQL
    // category rather than the analytics one.
    const sqlCategory = dialogSource.match(/key: "sql",\s*\n\s*titleKey: "connection\.databaseCategorySql",\s*\n\s*optionValues: \[([\s\S]*?)\]/)?.[1] ?? "";
    const analyticsCategory = dialogSource.match(/key: "analytics",[\s\S]*?optionValues: \[([\s\S]*?)\]/)?.[1] ?? "";
    expect(sqlCategory).toContain('"spanner"');
    expect(analyticsCategory).not.toContain('"spanner"');
  });

  it("does not expose external JDBC driver configuration because the driver is bundled", () => {
    const nativeAgentDriverSupport = dialogSource.match(/function supportsNativeAgentJdbcDriverConfigType\(dbType: DatabaseType\): boolean \{([\s\S]*?)\}/)?.[1] ?? "";
    const jdbcBackedDatabaseTypes = dialogSource.match(/const jdbcBackedDatabaseTypes = new Set<DatabaseType>\(\[([\s\S]*?)\]\);/)?.[1] ?? "";

    expect(nativeAgentDriverSupport).toContain('dbType === "bigquery"');
    expect(nativeAgentDriverSupport).not.toContain('dbType === "spanner"');
    expect(jdbcBackedDatabaseTypes).not.toContain('"spanner"');
  });

  it("collects the resource path through dedicated fields instead of host and credentials", () => {
    expect(dialogSource).toContain('import SpannerConnectionFields from "@/components/connection/SpannerConnectionFields.vue";');
    expect(dialogSource).toContain('<SpannerConnectionFields v-model:database="form.database" @change="resetTestState" />');
    // User, password, and the generic database row are hidden for Spanner.
    // These pin the whole v-if because the rows are shared, so adding another
    // database that opts out of one of them means updating the string here too.
    expect(dialogSource).toContain("<div v-if=\"form.db_type !== 'meilisearch' && form.db_type !== 'spanner'\" class=\"grid grid-cols-4 items-center gap-4\">");
    expect(dialogSource).toContain('<div v-if="form.db_type !== \'spanner\'" class="grid grid-cols-4 items-center gap-4">');
    expect(dialogSource).toContain("<div v-if=\"form.db_type !== 'hbase' && form.db_type !== 'meilisearch' && form.db_type !== 'spanner'\" class=\"grid grid-cols-4 items-center gap-4\">");
    // Switching to the Spanner profile clears host and credentials.
    expect(dialogSource).toContain('if (profile.type === "spanner") {');
    // Save/Test gating and submit-time normalization.
    expect(dialogSource).toContain("if (isSpannerConnection(form.value)) return hasSpannerResourcePath(form.value);");
    expect(dialogSource).toContain("normalizeSpannerConnection(config);");
    expect(dialogSource).toContain('throw new Error(t("connection.spannerFieldsRequired"));');
  });

  it("stays inside the generic branch so the agent install hint and URL params remain available", () => {
    const spannerBlockStart = dialogSource.indexOf("<!-- Cloud Spanner: project/instance/database resource path instead of user/password/database -->");
    const genericBranchStart = dialogSource.indexOf("<!-- MySQL / PostgreSQL: host, port, user, password, database -->");
    const urlParamsRow = dialogSource.indexOf('v-if="supportsGenericUrlParams"');
    const agentInstallHint = dialogSource.indexOf('v-if="shouldShowAgentDriverInstallHint"');

    expect(genericBranchStart).toBeGreaterThan(0);
    expect(spannerBlockStart).toBeGreaterThan(genericBranchStart);
    expect(urlParamsRow).toBeGreaterThan(spannerBlockStart);
    expect(agentInstallHint).toBeGreaterThan(spannerBlockStart);
    expect(dialogSource).toContain("'credentials=/path/key.json;autocommit=true'");
  });

  it("offers both the structured editor and the raw resource path editor", () => {
    expect(fieldsSource).toContain('const database = defineModel<string | undefined>("database");');
    expect(fieldsSource).toContain("data-spanner-resource-fields");
    expect(fieldsSource).toContain('t("connection.spannerProject")');
    expect(fieldsSource).toContain('t("connection.spannerInstance")');
    expect(fieldsSource).toContain('t("connection.spannerDatabase")');
    expect(fieldsSource).toContain('t("connection.spannerResourcePathMode")');
    expect(fieldsSource).toContain('emit("change")');
  });
});
