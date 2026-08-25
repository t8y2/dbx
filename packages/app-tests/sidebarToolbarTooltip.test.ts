import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const connectionTreeSource = readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8");
const activeConnectionFilterSource = readFileSync("apps/desktop/src/components/sidebar/ActiveConnectionFilterButton.vue", "utf8");
const toolbarStart = connectionTreeSource.indexOf('<div class="connection-tree-search');
const toolbarEnd = connectionTreeSource.indexOf("<CustomContextMenu", toolbarStart);
const toolbarSource = connectionTreeSource.slice(toolbarStart, toolbarEnd);
const toolbarActionSource = `${toolbarSource}\n${activeConnectionFilterSource}`;

test("connection tree toolbar uses app tooltips for icon-only actions", () => {
  for (const tooltip of [
    `<LightTooltip :text="t('sidebar.locateActiveTab')" side="top" :delay="300" nowrap>`,
    `<LightTooltip :text="t('sidebar.sortConnections')" side="top" :delay="300" nowrap>`,
    `<LightTooltip v-if="searchScopeOptions.length > 0" :text="t('sidebar.filterByType')" side="top" :delay="300" nowrap>`,
  ]) {
    assert.ok(toolbarSource.includes(tooltip));
  }
  assert.ok(toolbarSource.includes("<ActiveConnectionFilterButton"));
  assert.ok(activeConnectionFilterSource.includes(`<LightTooltip :text="t('sidebar.showActiveConnectionsOnly')" side="top" :delay="300" nowrap>`));

  assert.doesNotMatch(toolbarActionSource, /:title="t\('sidebar\.(?:locateActiveTab|showActiveConnectionsOnly)'\)"/);
  assert.doesNotMatch(toolbarSource, /:trigger-title="t\('sidebar\.(?:sortConnections|filterByType)'\)"/);
});
