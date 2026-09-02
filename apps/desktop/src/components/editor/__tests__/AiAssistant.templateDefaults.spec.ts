import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for https://github.com/t8y2/dbx/issues/7649: per-db_type
// prompt template defaults + last-used fallback. The resolution rules live in
// lib/ai/promptTemplateDefaults.ts (unit-tested separately); this file pins
// that AiAssistant.vue wires them into the panel lifecycle:
//   - auto-apply once when the AI selection + templates are loaded,
//   - re-resolve on connection/database/schema switch (defaults only opt-in),
//   - record what was actually sent as the db_type's last-used templates.
const source = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");

describe("AI assistant applies per-db_type prompt template defaults", () => {
  it("panel-open resolution uses defaults-else-last-used through the tested helper and enforces the char cap", () => {
    const maybeBody = source.slice(source.indexOf("async function maybeApplyAutoTemplates()"), source.indexOf("// Reset template selection when the user switches"));
    expect(maybeBody).toContain("resolveAutoTemplateIds({");
    expect(maybeBody).toContain("defaultTemplatesByDbType: settings.aiDefaultTemplatesByDbType");
    expect(maybeBody).toContain("lastUsedTemplatesByDbType: settings.aiLastUsedTemplatesByDbType");
    expect(maybeBody).toContain("applyResolvedTemplateIds(");
    // The char cap lives in the shared apply helper both paths funnel through.
    const applyBody = source.slice(source.indexOf("function applyResolvedTemplateIds("), source.indexOf("async function maybeApplyAutoTemplates()"));
    expect(applyBody).toContain("capTemplateIdsToCharLimit(ids, promptTemplateStore.templates, ACTIVE_TEMPLATES_TOTAL_MAX)");
  });

  it("auto-apply waits for the AI selection load, runs once, and skips failed template loads", () => {
    const maybeBody = source.slice(source.indexOf("async function maybeApplyAutoTemplates()"), source.indexOf("// Reset template selection when the user switches"));
    expect(maybeBody).toContain("if (autoTemplatesInitialized || !settings.isAiConfigLoaded) return;");
    expect(maybeBody).toContain("if (!(await promptTemplateStore.ensureLoaded())) return;");
    expect(maybeBody).toContain("autoTemplatesInitialized = true;");
    expect(maybeBody).toContain("applyResolvedTemplateIds(");
  });

  it("namespace switch re-resolves defaults only when both stores are loaded, otherwise clears", () => {
    const watcherBody = source.slice(source.indexOf("aiTemplateNamespaceKey,"), source.indexOf("function toggleTemplateId("));
    expect(watcherBody).toContain("if (!settings.isAiConfigLoaded || !promptTemplateStore.isLoaded) {");
    expect(watcherBody).toContain("activeTemplateIds.value = [];");
    // The switch path must resolve through the defaults-only helper; the
    // mount resolver (defaults-else-last-used) would resurrect cleared
    // selections. Pin the exact call so an indirect last-used fallback
    // cannot hide behind a shared helper again.
    expect(watcherBody).toContain("resolveDefaultTemplateIds(templateDbType.value, settings.aiDefaultTemplatesByDbType)");
    expect(watcherBody).not.toContain("resolveAutoTemplateIds");
    expect(watcherBody).not.toContain("lastUsedTemplatesByDbType");
  });

  it("keys defaults, last-used, and the badge by the effective AI database type", () => {
    // Same axis aiDatabaseTypeForConnection established for schema selection:
    // gbase → mysql, doris-over-mysql protocol → doris, jdbc → inferred
    // dialect. Raw db_type keying would never match for those connections.
    expect(source).toContain("const templateDbType = computed(() => (props.connection ? aiDatabaseTypeForConnection(props.connection) : undefined));");
    expect(source).toContain("aiDatabaseTypeForConnection");
  });

  it("panel-open resolution bails when the namespace switched during the load await", () => {
    const maybeBody = source.slice(source.indexOf("async function maybeApplyAutoTemplates"), source.indexOf("watch(", source.indexOf("async function maybeApplyAutoTemplates")));
    expect(maybeBody).toContain("const namespaceAtStart = aiTemplateNamespaceKey.value;");
    expect(maybeBody).toContain("if (namespaceAtStart !== aiTemplateNamespaceKey.value) return;");
  });

  it("selector-open load retry also applies pending defaults", () => {
    const watcherBody = source.slice(source.indexOf("watch(showTemplateSelector"), source.indexOf("// Auto-apply per-db_type"));
    expect(watcherBody).toContain("void promptTemplateStore.ensureLoaded().then(() => void maybeApplyAutoTemplates());");
  });

  it("send records the sent templates as the db_type's last-used selection", () => {
    const sendIdx = source.indexOf("activeTemplates: [...activeTemplates.value],");
    const recordIdx = source.indexOf("settings.recordLastUsedTemplates(templateDbType.value, [...activeTemplateIds.value]);");
    expect(recordIdx).toBeGreaterThan(sendIdx);
    // No length guard: an empty selection must also reach the store so the
    // remembered entry is cleared instead of resurrecting old templates.
    const guard = source.slice(sendIdx, recordIdx);
    expect(guard).toContain("if (templateDbType.value) {");
    expect(guard).not.toContain("activeTemplates.value.length > 0");
  });

  it("the template selector marks defaults for the current connection db_type", () => {
    expect(source).toContain('v-if="isDefaultTemplateForCurrentDb(tpl.id)"');
    expect(source).toContain("settings.aiDefaultTemplatesByDbType[dbType]?.includes(id) ?? false");
  });
});
