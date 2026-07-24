import assert from "node:assert/strict";
import { test } from "vitest";

import { isAppReleaseTag } from "./releaseTags";

test("recognizes only DBX app release tags", () => {
  assert.equal(isAppReleaseTag("v0.5.66"), true);
  assert.equal(isAppReleaseTag("v1.2.3-hotfix.1"), true);
  assert.equal(isAppReleaseTag("packages-v0.4.42"), false);
  assert.equal(isAppReleaseTag("agents-v0.2.64"), false);
  assert.equal(isAppReleaseTag("v0.5.x"), false);
});
