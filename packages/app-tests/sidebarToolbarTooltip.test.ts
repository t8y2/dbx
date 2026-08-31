import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const connectionTreeSource = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");
const appSidebarSource = readFileSync("apps/desktop/src/components/layout/AppSidebar.vue", "utf8");
const activeConnectionFilterSource = readFileSync("apps/desktop/src/components/sidebar/ActiveConnectionFilterButton.vue", "utf8");
const toolbarStart = connectionTreeSource.indexOf('<div class="connection-tree-search');
const toolbarEnd = connectionTreeSource.indexOf("<CustomContextMenu", toolbarStart);
const toolbarSource = connectionTreeSource.slice(toolbarStart, toolbarEnd);
const toolbarActionSource = `${toolbarSource}\n${activeConnectionFilterSource}`;

test("connection tree toolbar uses app tooltips for icon-only actions", () => {
  for (const tooltip of [`<LightTooltip :text="t('sidebar.locateActiveTab')" side="top" :delay="300" nowrap>`, `<LightTooltip :text="sidebarListOptionsLabel" side="top" :delay="300" nowrap>`]) {
    assert.ok(toolbarSource.includes(tooltip));
  }
  assert.ok(toolbarSource.includes("<ActiveConnectionFilterButton"));
  assert.ok(toolbarSource.includes('<LocateFixed class="h-3.5 w-3.5" />'));
  assert.ok(activeConnectionFilterSource.includes(`<LightTooltip :text="t('sidebar.showActiveConnectionsOnly')" side="top" :delay="300" nowrap>`));

  assert.doesNotMatch(toolbarActionSource, /:title="t\('sidebar\.(?:locateActiveTab|showActiveConnectionsOnly)'\)"/);
  assert.doesNotMatch(toolbarSource, /:trigger-title=/);
});

test("connection tree toolbar groups low-frequency controls", () => {
  assert.ok(toolbarSource.includes("pr-[4.75rem]"));
  assert.ok(toolbarSource.includes("sidebar.regexSearchTooltip"));
  assert.ok(toolbarSource.indexOf("sidebar.globalLocalSearchTooltip") < toolbarSource.indexOf("sidebar.locateActiveTab"));
  assert.ok(toolbarSource.includes('class="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border'));
  assert.ok(toolbarSource.includes(':items="sidebarListOptionItems"'));
  assert.ok(connectionTreeSource.includes('groupLabel: index === 0 ? t("sidebar.sortConnections") : undefined'));
  assert.ok(connectionTreeSource.includes('groupLabel: index === 0 ? t("sidebar.filterByType") : undefined'));
  assert.ok(!toolbarSource.includes(':label="sidebarListOptionsLabel"'));
  assert.equal((toolbarSource.match(/<LightDropdown/g) ?? []).length, 1);
  assert.equal((toolbarSource.match(/border border-border/g) ?? []).length, 2);
});

test("connection sidebar exposes import and export actions", () => {
  assert.ok(appSidebarSource.includes(':trigger-icon="ArrowDownUp"'));
  assert.ok(appSidebarSource.includes('<ChevronsDownUp class="h-3 w-3" />'));
  assert.ok(appSidebarSource.includes(':trigger-label="connectionTransferLabel"'));
  assert.ok(appSidebarSource.includes('t("sidebar.importExport")'));
  assert.ok(appSidebarSource.includes(':items="connectionTransferItems"'));
  assert.ok(appSidebarSource.includes('@update:model-value="selectConnectionTransferAction"'));
  assert.doesNotMatch(appSidebarSource, /:trigger-icon="Ellipsis"/);
});
