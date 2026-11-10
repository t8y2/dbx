import assert from "node:assert/strict";
import test from "node:test";

import { planReleaseRetention, pruneOldReleases } from "./cleanup-cnb-releases.mjs";

function release(id, tag, publishedAt) {
  return { id, tag_name: tag, published_at: publishedAt };
}

const appReleases = [
  release("69", "v0.5.69", "2026-07-29T05:35:19Z"),
  release("68", "v0.5.68", "2026-07-27T05:35:19Z"),
  release("67", "v0.5.67", "2026-07-25T05:35:19Z"),
  release("66", "v0.5.66", "2026-07-23T05:35:19Z"),
  release("65", "v0.5.65", "2026-07-21T05:35:19Z"),
  release("64", "v0.5.64", "2026-07-19T05:35:19Z"),
];

test("retention only removes old releases from the selected family", () => {
  const plan = planReleaseRetention([release("agents-latest", "agents-latest", "2026-01-01T00:00:00Z"), release("agent", "agents-v0.2.67", "2026-07-29T05:35:19Z"), ...appReleases.toReversed()], {
    currentTag: "v0.5.69",
    tagPattern: "^v[0-9]+[.][0-9]+[.][0-9]+$",
    retain: 5,
  });

  assert.equal(plan.skipped, "");
  assert.deepEqual(
    plan.keep.map((item) => item.tag),
    ["v0.5.69", "v0.5.68", "v0.5.67", "v0.5.66", "v0.5.65"],
  );
  assert.deepEqual(
    plan.remove.map((item) => item.tag),
    ["v0.5.64"],
  );
});

test("retention skips cleanup when syncing an older release", () => {
  const plan = planReleaseRetention(appReleases, {
    currentTag: "v0.5.64",
    tagPattern: "^v[0-9]+[.][0-9]+[.][0-9]+$",
    retain: 5,
  });

  assert.match(plan.skipped, /not among the latest 5/);
  assert.deepEqual(plan.remove, []);
});

test("retention rejects incomplete release metadata", () => {
  assert.throws(
    () =>
      planReleaseRetention([{ id: "broken", tag_name: "v0.5.69" }], {
        currentTag: "v0.5.69",
        tagPattern: "^v",
        retain: 1,
      }),
    /missing id, tag, or publish time/,
  );
});

test("pruneOldReleases is a dry run unless apply is enabled", async () => {
  const deleted = [];
  const client = {
    async listReleases() {
      return appReleases;
    },
    async deleteRelease(id) {
      deleted.push(id);
    },
  };

  await pruneOldReleases(client, {
    currentTag: "v0.5.69",
    tagPattern: "^v[0-9]+[.][0-9]+[.][0-9]+$",
    retain: 5,
    apply: false,
  });
  assert.deepEqual(deleted, []);

  await pruneOldReleases(client, {
    currentTag: "v0.5.69",
    tagPattern: "^v[0-9]+[.][0-9]+[.][0-9]+$",
    retain: 5,
    apply: true,
  });
  assert.deepEqual(deleted, ["64"]);
});

// Keep these in sync with the "Keep latest five app releases in CNB" step in release.yml.
const betaPattern = "^v[0-9]+[.][0-9]+[.][0-9]+-beta[.][0-9]{8}[.][0-9]+$";
const stablePattern = "^(?!.*-beta[.])v[0-9]+[.][0-9]+[.][0-9]+([.-][0-9A-Za-z.-]+)?$";

const mixedReleases = [
  ...appReleases,
  release("b6", "v0.5.70-beta.20260730.1", "2026-07-30T05:35:19Z"),
  release("b5", "v0.5.70-beta.20260731.1", "2026-07-31T05:35:19Z"),
  release("b4", "v0.5.70-beta.20260801.1", "2026-08-01T05:35:19Z"),
  release("b3", "v0.5.70-beta.20260802.1", "2026-08-02T05:35:19Z"),
  release("b2", "v0.5.70-beta.20260803.1", "2026-08-03T05:35:19Z"),
  release("b1", "v0.5.70-beta.20260804.1", "2026-08-04T05:35:19Z"),
];

test("beta retention never evicts stable releases", () => {
  const plan = planReleaseRetention(mixedReleases, { currentTag: "v0.5.70-beta.20260804.1", tagPattern: betaPattern, retain: 5 });

  assert.equal(plan.skipped, "");
  assert.deepEqual(
    plan.remove.map((item) => item.tag),
    ["v0.5.70-beta.20260730.1"],
  );
});

test("stable retention ignores beta releases", () => {
  const plan = planReleaseRetention(mixedReleases, { currentTag: "v0.5.69", tagPattern: stablePattern, retain: 5 });

  assert.equal(plan.skipped, "");
  assert.deepEqual(
    plan.keep.map((item) => item.tag),
    ["v0.5.69", "v0.5.68", "v0.5.67", "v0.5.66", "v0.5.65"],
  );
  assert.deepEqual(
    plan.remove.map((item) => item.tag),
    ["v0.5.64"],
  );
});

test("stable retention skips when the current tag is a beta", () => {
  const plan = planReleaseRetention(mixedReleases, { currentTag: "v0.5.70-beta.20260804.1", tagPattern: stablePattern, retain: 5 });

  assert.match(plan.skipped, /outside the retention family/);
  assert.deepEqual(plan.remove, []);
});
