import { readFileSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "vue/compiler-sfc";
import { describe, expect, it } from "vitest";
import { SETTINGS_SEARCH_DEFINITIONS, createShortcutSettingsSearchDefinitions, resolveSettingsSearchEntries, searchSettings, type SettingsCategory } from "@/lib/settings/settingsSearch";
import en from "@/i18n/locales/en";
import zhCN from "@/i18n/locales/zh-CN";
import { SHORTCUT_DEFINITIONS } from "@/lib/editor/shortcutRegistry";
import { MCP_TOOL_OPTIONS } from "@/lib/mcp/mcpPolicySelection";
import { SQL_VARIABLE_SYNTAX_KEYS } from "@/lib/sql/sqlVariableSyntax";
import { APP_CUSTOM_UI_COLOR_DEFS } from "@/lib/app/appTheme";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = resolve(src, "components/editor/EditorSettingsDialog.vue");

/** Findings key with POSIX separators so the expectations stay stable on Windows. */
function relativePosix(file: string): string {
  return relative(src, file).split(sep).join("/");
}

// These dialogs display transient operations or release notes, not persisted settings.
// UI primitives and decorative icons are excluded by directory, not by control label.
const excludedComponents: Record<string, string> = {
  DangerConfirmDialog: "Confirmation of an operation, not a configuration form",
  CloudSyncSelectionDialog: "Per-operation conflict/import selection, not sync configuration",
  ChangelogPanel: "Release notes, not settings",
  ConnectionGroupBadge: "Decorative connection group indicator",
};
const excludedLabels: Record<string, string> = {
  "settings.syncSavedPassword": "Saved-credential status, not an editable field",
  "settings.mcpUpdateCommand": "Read-only installation command",
  "settings.mcpInstallCommand": "Read-only installation command",
  "settings.mcpUninstallCommand": "Read-only removal command",
  "settings.updateStatusTitle": "Installed/available release status",
  "auth.logout": "Session action, not a preference",
  "settings.sqlShortcutsPreview": "Read-only generated SQL preview",
  "ai.aiImportSelectConfig": "Per-import record selection",
  "ai.aiImportUnsupported": "Disabled unsupported-import indicator",
  "databaseBackup.searchHistoryConnections": "Transient history filter",
  "databaseBackup.backupMethod": "Transient history filter",
  "databaseBackup.backupStatus": "Transient history filter",
  "databaseBackup.selectAllFiltered": "Selection for a batch history action",
  "databaseBackup.selectRun": "Selection for a history action",
  "databaseBackup.searchConnections": "Filter inside a connection picker",
  "databaseBackup.searchDatabases": "Filter inside a database picker",
  "settings.preview": "Read-only editor preview",
  "settings.searchSettings": "The settings search query itself",
  "settings.shortcutPressShortcut": "Shortcut recorder instructions; every shortcut is indexed by its canonical definition",
  "settings.customUiEditingDark": "Current color-editing mode indicator",
  "settings.customUiEditingLight": "Current color-editing mode indicator",
};

// Dynamic labels must have an audited canonical source or a static protocol alias.
// A newly introduced computed label should fail coverage until its source is accounted for.
const auditedNonLiteralLabels: Record<string, string> = {
  executeModeLabel: "Translated settings.executeMode",
  "SQL_VARIABLE_SYNTAX_TOKENS[key] t(`settings.sqlVariableSyntax_${key}`)": "SQL_VARIABLE_SYNTAX_KEYS tested below",
  "t(definition.labelKey)": "SHORTCUT_DEFINITIONS tested below",
  "t(def.labelKey)": "APP_CUSTOM_UI_COLOR_DEFS tested below",
  "getToolbarVisibilityItemLabel(item)": "Toolbar controls and index share TOOLBAR_VISIBILITY_ITEMS",
  "t(tool.labelKey)": "MCP_TOOL_OPTIONS tested below",
  "t(`settings.${titleKey}`) t(option.labelKey)": "Formatter rule titles and option labels derived from the SFC below",
  "t(`settings.${titleKey}`)": "Formatter rule titles derived from the SFC below",
  "t(`settings.${titleKey}`) t(`settings.sqlFormatterRule_${value}`)": "Formatter rule titles and enum labels derived from the SFC below",
  database: "User-owned database names must never enter the static search index",
  Authentication: "Static AI protocol alias tested below",
  Endpoint: "Static AI protocol alias tested below",
  API: "Static AI protocol alias tested below",
  aiCredentialLabel: "Static Auth Token / API Key aliases tested below",
  "Bearer Token": "Static MCP protocol alias tested below",
};
const unauditedLabels: string[] = [];

interface AstNode {
  type: number;
  tag?: string;
  content?: string | AstNode;
  children?: AstNode[];
  props?: { type: number; name: string; value?: { content: string }; arg?: { content: string }; exp?: { content: string } }[];
}
function translationKeys(expression: string): string[] {
  return [...expression.matchAll(/\bt\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
}
function expressions(node: AstNode): string {
  return [typeof node.content === "string" ? node.content : node.content ? expressions(node.content) : "", ...(node.children ?? []).map(expressions)].join(" ");
}

/** Follow rendered business components, so a newly extracted settings panel is audited automatically. */
function inspectSettingsTemplates(entry: string): Map<string, Set<string>> {
  const findings = new Map<string, Set<string>>();
  const visited = new Set<string>();
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    const { descriptor } = parse(readFileSync(file, "utf8"), { filename: file });
    const script = [descriptor.script?.content, descriptor.scriptSetup?.content].join("\n");
    const imports = new Map([...script.matchAll(/import\s+(\w+)\s+from\s+["']([^"']+\.vue)["']/g)].map((match) => [match[1], match[2]]));
    const keys = new Set<string>();
    const components = new Set<string>();
    function walk(node: AstNode) {
      if (node.tag) {
        if (imports.has(node.tag)) components.add(node.tag);
        if (node.tag.toLowerCase() === "label") {
          const expression = expressions(node).trim().replace(/\s+/g, " ");
          const translated = translationKeys(expression);
          translated.forEach((key) => keys.add(key));
          if (expression && !translated.length && !auditedNonLiteralLabels[expression]) unauditedLabels.push(`${relativePosix(file)}: ${expression}`);
        }
        // Buttons with configuration roles are settings, not ordinary action buttons.
        const role = node.props?.find((prop) => prop.name === "role")?.value?.content;
        const isChoice = role === "radio" || role === "switch" || role === "checkbox";
        if (isChoice) translationKeys(expressions(node)).forEach((key) => keys.add(key));
        // Include group accessible names even when the group uses a plain div.
        if (isChoice || role === "radiogroup" || /^(Input|input|Textarea|textarea|Select|SelectTrigger|Switch|Checkbox|PasswordInput|ColorSpectrumPicker)$/.test(node.tag)) {
          for (const prop of node.props ?? []) {
            if (prop.name === "bind" && ["aria-label", "label"].includes(prop.arg?.content ?? "")) {
              translationKeys(prop.exp?.content ?? "").forEach((key) => keys.add(key));
            }
          }
        }
      }
      node.children?.forEach(walk);
    }
    if (descriptor.template?.ast) walk(descriptor.template.ast as unknown as AstNode);
    // Color editors use canonical arrays inside the SFC rather than individual <Label>s.
    // Derive keys from those definitions so adding a color field cannot silently escape coverage.
    if (/ThemeCustomizerDialog|DataGridTypeColorSchemeDialog/.test(file)) {
      for (const match of script.matchAll(/labelKey:\s*["']([^"']+)["']|label:\s*t\(\s*["']([^"']+)["']/g)) keys.add(match[1] ?? match[2]);
    }
    // Formatter rule rows render their labels from local definitions rather than literal template keys.
    if (file.endsWith("SqlFormatterSettingsPanel.vue")) {
      for (const match of script.matchAll(/titleKey:\s*["']([^"']+)["']/g)) keys.add(`settings.${match[1]}`);
      for (const match of script.matchAll(/labelKey:\s*["']([^"']+)["']/g)) keys.add(match[1]);
      const ruleEnums = script.match(/const ruleEnums = \{([\s\S]*?)\} as const;/)?.[1];
      if (!ruleEnums) throw new Error("Formatter rule enum source is missing");
      for (const match of ruleEnums.matchAll(/["']([^"']+)["']/g)) keys.add(`settings.sqlFormatterRule_${match[1]}`);
    }
    findings.set(relativePosix(file), keys);
    for (const component of components) {
      if (excludedComponents[component]) continue;
      const importPath = imports.get(component)!;
      const target = importPath.startsWith("@/") ? resolve(src, importPath.slice(2)) : resolve(dirname(file), importPath);
      if (/\/components\/(ui|icons)\//.test(target)) continue;
      visit(target);
    }
  }
  visit(entry);
  return findings;
}

const definitions = [...SETTINGS_SEARCH_DEFINITIONS, ...createShortcutSettingsSearchDefinitions(SHORTCUT_DEFINITIONS)];
const indexedKeys = new Set(definitions.flatMap((definition) => [definition.titleKey, definition.descriptionKey, ...(definition.keywordKeys ?? [])]).filter(Boolean));

describe("settings search template coverage", () => {
  const controls = inspectSettingsTemplates(root);
  it("requires an audited source for computed and literal labels", () => {
    expect(unauditedLabels).toEqual([]);
  });
  it("follows nested settings forms, including backup and authorization fields", () => {
    expect([...controls.keys()]).toEqual(
      expect.arrayContaining(["components/backup/DatabaseBackupConfigFields.vue", "components/connection/TunnelProfileManager.vue", "components/settings/McpAuthorizationTabs.vue", "components/editor/SqlFormatterSettingsPanel.vue", "components/grid/DataGridTypeColorSchemeDialog.vue"]),
    );
  });
  for (const [file, keys] of controls) {
    it(`indexes fixed control labels in ${file}`, () => {
      const missing = [...keys].filter((key) => !indexedKeys.has(key) && !excludedLabels[key]);
      expect(missing, "Add a search result or localized keyword on the owning management entry; exclude only transient UI with a reason.").toEqual([]);
    });
  }
  it("covers loop-generated custom UI colors from the canonical definitions", () => {
    expect(APP_CUSTOM_UI_COLOR_DEFS.map((item) => item.labelKey).filter((key) => !indexedKeys.has(key))).toEqual([]);
  });
  it("covers loop-generated SQL syntax and MCP tools from their canonical definitions", () => {
    const keys = [...SQL_VARIABLE_SYNTAX_KEYS.map((key) => `settings.sqlVariableSyntax_${key}`), ...MCP_TOOL_OPTIONS.map((tool) => tool.labelKey)];
    expect(keys.filter((key) => !indexedKeys.has(key))).toEqual([]);
  });
  it("resolves every fixed search anchor in the settings component tree", () => {
    const sources = [...controls.keys()].map((file) => parse(readFileSync(resolve(src, file), "utf8")).descriptor.template?.content ?? "");
    const anchors = new Set(sources.flatMap((source) => [...source.matchAll(/data-settings-search-id="([^"`]+)"/g)].map((match) => match[1])));
    // Authorization tabs generate their anchors from the same four section IDs.
    for (const section of ["overrides", "connections", "databases", "capabilities"]) anchors.add(`mcp-${section}`);
    expect(definitions.filter((definition) => !anchors.has(definition.targetId ?? definition.category)).map((definition) => definition.id)).toEqual([]);
  });
  it("uses unique result IDs, including canonical shortcut entries", () => {
    expect(new Set(definitions.map((definition) => definition.id)).size).toBe(definitions.length);
  });
});

const categories = [...new Set(definitions.map((definition) => definition.category))];
const categoryLabels = Object.fromEntries(categories.map((category) => [category, category])) as Record<SettingsCategory, string>;
function messageAt(messages: object, key: string): unknown {
  return key.split(".").reduce<unknown>((value, part) => (value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined), messages);
}

describe("settings search localization coverage", () => {
  for (const [locale, messages] of [
    ["en", en],
    ["zh-CN", zhCN],
  ] as const) {
    it(`resolves every indexed translation key in ${locale}`, () => {
      const missing = [...indexedKeys].filter((key) => !key || typeof messageAt(messages, key) !== "string");
      expect(missing).toEqual([]);
    });
    it(`finds MCP scope choices and custom tool rules with their authorization routes in ${locale}`, () => {
      for (const isWeb of [false, true]) {
        const entries = resolveSettingsSearchEntries(definitions, { isWeb, visibleCategories: new Set(categories) }, (key) => String(messageAt(messages, key) ?? key), categoryLabels);
        for (const key of ["mcpResourceScopeTitle", "mcpScopeModeAll", "mcpResourceScopeModeCustom"]) {
          const results = searchSettings(entries, String(messageAt(messages, `settings.${key}`)), locale, Infinity);
          expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: "mcp-connections", route: { mcpManagementTab: "permissions", mcpAuthorizationTab: "connections" } })]));
        }
        for (const key of ["mcpDatabaseScopeAriaLabel", "mcpDatabaseScopeAllTitle", "mcpDatabaseScopeSelectedTitle", "mcpDatabaseScopeNoneTitle"]) {
          const results = searchSettings(entries, String(messageAt(messages, `settings.${key}`)), locale, Infinity);
          expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: "mcp-databases", route: { mcpManagementTab: "permissions", mcpAuthorizationTab: "databases" } })]));
        }
        for (const query of [locale === "zh-CN" ? "通配符" : "wildcard", "dbx_ssh__*"]) {
          expect(searchSettings(entries, query, locale, Infinity)).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: "mcp-capabilities", route: { mcpManagementTab: "permissions", mcpAuthorizationTab: "capabilities" } })]));
        }
      }
    });
    it(`finds every visible title and keyword in ${locale} on both platforms`, () => {
      for (const isWeb of [false, true]) {
        const entries = resolveSettingsSearchEntries(
          definitions,
          {
            isWeb,
            visibleCategories: new Set(categories),
            hasSqlServerConnection: true,
          },
          (key) => String(messageAt(messages, key) ?? key),
          categoryLabels,
        );
        for (const entry of entries) {
          expect(
            searchSettings(entries, entry.title, locale, Infinity).map((result) => result.id),
            entry.id,
          ).toContain(entry.id);
          const definition = definitions.find((item) => item.id === entry.id)!;
          for (const key of definition.keywordKeys ?? []) {
            const keyword = String(messageAt(messages, key) ?? key);
            expect(
              searchSettings(entries, keyword, locale, Infinity).map((result) => result.id),
              `${entry.id}: ${key}`,
            ).toContain(entry.id);
          }
        }
      }
    });
  }
  it("finds literal protocol and credential labels without indexing user credentials", () => {
    const entries = resolveSettingsSearchEntries(definitions, { isWeb: false, visibleCategories: new Set(categories) }, (key) => String(messageAt(en, key) ?? key), categoryLabels);
    for (const label of ["Authentication", "Endpoint", "API", "Auth Token", "API Key"]) {
      expect(searchSettings(entries, label, "en", Infinity).map((entry) => entry.id)).toContain("ai-config");
    }
    expect(searchSettings(entries, "Bearer Token", "en", Infinity).some((entry) => entry.category === "mcp")).toBe(true);
  });
});

describe("settings search platform and limit regressions", () => {
  const entriesFor = (isWeb: boolean) => resolveSettingsSearchEntries(definitions, { isWeb, visibleCategories: new Set(categories) }, (key) => String(messageAt(en, key) ?? key), categoryLabels);
  it("keeps backups searchable on Web but hides desktop-only controls", () => {
    const desktop = entriesFor(false).map((entry) => entry.id);
    const web = entriesFor(true).map((entry) => entry.id);
    expect(web).toContain("backups");
    for (const id of ["data-dameng-client-bin-dir", "backups-background-worker", "appearance-background-image", "appearance-background-image-display-mode", "appearance-background-image-transparency", "appearance-background-image-blur"]) {
      expect(desktop).toContain(id);
      expect(web).not.toContain(id);
    }
  });
  it("returns all matches on explicit Infinity while retaining finite caller limits", () => {
    const entries = entriesFor(false);
    const expected = entries.filter((entry) => entry.category === "shortcuts");
    expect(expected.length).toBeGreaterThan(8);
    const results = searchSettings(entries, "shortcuts", "en", Infinity);
    expect(results.map((entry) => entry.id)).toEqual(expect.arrayContaining(expected.map((entry) => entry.id)));
    expect(searchSettings(entries, "shortcuts", "en", 3)).toHaveLength(3);
  });
});
