import assert from "node:assert/strict";
import { test } from "vitest";

import { addDriverInstallQueue, driverInstallProgressPercent, isDriverInstallProgressTarget, removeDriverInstallQueue, takeNextDriverInstallQueue } from "../../apps/desktop/src/lib/driverInstallProgressUi.ts";

test("formats driver install progress as a bounded whole percent", () => {
  assert.equal(driverInstallProgressPercent({ step: "driver", downloaded: 3_900_000, total: 10_500_000 }), 37);
  assert.equal(driverInstallProgressPercent({ step: "driver", downloaded: -1, total: 10 }), 0);
  assert.equal(driverInstallProgressPercent({ step: "driver", downloaded: 11, total: 10 }), 100);
});

test("returns null when install progress has no measurable total", () => {
  assert.equal(driverInstallProgressPercent(null), null);
  assert.equal(driverInstallProgressPercent({ step: "jre-extract" }), null);
  assert.equal(driverInstallProgressPercent({ step: "driver", downloaded: 1, total: 0 }), null);
});

test("targets only the row currently installing or upgrading", () => {
  assert.equal(isDriverInstallProgressTarget("mysql", { installing: "mysql", upgradingAll: false, progress: null }), true);
  assert.equal(isDriverInstallProgressTarget("postgres", { installing: "mysql", upgradingAll: false, progress: null }), false);
  assert.equal(
    isDriverInstallProgressTarget("postgres", {
      installing: null,
      upgradingAll: true,
      progress: { step: "driver", db_type: "postgres", downloaded: 1, total: 2 },
    }),
    true,
  );
});

test("adds queued driver installs without duplicating the active or queued driver", () => {
  assert.deepEqual(addDriverInstallQueue(["postgres"], "mysql", "sqlite"), ["postgres", "mysql"]);
  assert.deepEqual(addDriverInstallQueue(["postgres"], "postgres", "sqlite"), ["postgres"]);
  assert.deepEqual(addDriverInstallQueue(["postgres"], "sqlite", "sqlite"), ["postgres"]);
});

test("removes queued driver installs", () => {
  assert.deepEqual(removeDriverInstallQueue(["postgres", "mysql", "sqlite"], "mysql"), ["postgres", "sqlite"]);
});

test("takes the next installable queued driver and drops stale queued drivers", () => {
  const result = takeNextDriverInstallQueue(["installed", "mysql", "sqlite"], (dbType) => dbType !== "installed");

  assert.equal(result.next, "mysql");
  assert.deepEqual(result.queue, ["sqlite"]);
});
