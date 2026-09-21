import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

// The table-properties drawer exists twice (DataGrid and ObjectBrowser), each
// with its own tab list, plus a shared body component. A partitions tab must be
// wired into all of them together, otherwise the drawer silently loses the tab
// on one surface.
const drawerSurfaces = [
  "apps/desktop/src/components/grid/DataGrid.vue",
  "apps/desktop/src/components/objects/ObjectBrowser.vue",
];

test("both table-properties drawers expose a capability-gated partitions tab", () => {
  for (const path of drawerSurfaces) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /id:\s*"partitions"/, `${path} must add a partitions tab`);
    assert.match(
      source,
      /tableMetadataCapabilities\.value\.partitions/,
      `${path} must gate the partitions tab on the capability`,
    );
    // A plain table must not show the tab at all, so both drawers probe the
    // cheap partition status and gate on the result.
    assert.match(source, /api\.getTablePartitionStatus/, `${path} must probe the partition status`);
    assert.match(source, /isPartitionedTable|tableIsPartitioned/, `${path} must gate on the probed status`);
    assert.match(source, /fetchPartitions|fetchTablePartitions/, `${path} must load partition metadata`);
  }
});

test("both drawers probe the partition status on demand, not only on table change", () => {
  // Regression: probing only in the table-change watcher meant opening the
  // drawer for an already-selected table never resolved the status, so the
  // Partitions tab was missing on every partitioned table.
  const expectations: Array<[string, RegExp]> = [
    ["apps/desktop/src/components/grid/DataGrid.vue", /if \(!partitionStatusResolved\.value\) await probeTablePartitionStatus\(\)/],
    [
      "apps/desktop/src/components/objects/ObjectBrowser.vue",
      /if \(!tablePartitionStatusResolved\.value\) await probeTablePartitionStatus\(\)/,
    ],
  ];
  for (const [path, pattern] of expectations) {
    assert.match(readFileSync(path, "utf8"), pattern, `${path} must probe on demand in selectTableInfoTab`);
  }
});

test("both drawers render the shared partitions panel", () => {
  const panels = readFileSync("apps/desktop/src/components/grid/DataGridTableInfoPanels.vue", "utf8");
  assert.match(panels, /TablePartitionsPanel/);

  const objectBrowser = readFileSync("apps/desktop/src/components/objects/ObjectBrowser.vue", "utf8");
  assert.match(objectBrowser, /TablePartitionsPanel/);
});

test("the partitions tab is a first-class persisted table-info tab", () => {
  const settings = readFileSync("apps/desktop/src/stores/settingsStore.ts", "utf8");
  assert.match(settings, /TABLE_INFO_TABS = new Set<TableInfoTab>\(\[[^\]]*"partitions"/);
});
