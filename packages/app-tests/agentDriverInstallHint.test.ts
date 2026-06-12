import assert from "node:assert/strict";
import { test } from "vitest";
import { showAgentDriverInstallHint } from "../../apps/desktop/src/lib/agentDriverInstallHint.ts";

test("hides the agent driver install hint when the selected driver is installed", () => {
  assert.equal(showAgentDriverInstallHint("informix", [{ db_type: "informix", installed: true }]), false);
});

test("shows the agent driver install hint when the selected driver is missing", () => {
  assert.equal(showAgentDriverInstallHint("informix", [{ db_type: "informix", installed: false }]), true);
});

test("shows the agent driver install hint for TDengine when missing", () => {
  assert.equal(showAgentDriverInstallHint("tdengine", [{ db_type: "tdengine", installed: false }]), true);
});

test("shows the agent driver install hint for Access when missing", () => {
  assert.equal(showAgentDriverInstallHint("access", [{ db_type: "access", installed: false }]), true);
});

test("does not show agent driver install hints for built-in database types", () => {
  assert.equal(showAgentDriverInstallHint("mysql", [{ db_type: "informix", installed: false }]), false);
});

test("uses the unified Oracle driver for legacy Oracle profiles", () => {
  assert.equal(
    showAgentDriverInstallHint(
      "oracle",
      [
        { db_type: "oracle", installed: false },
        { db_type: "oracle-legacy", installed: false },
        { db_type: "oracle-10g", installed: true },
      ],
      "oracle-10g",
    ),
    true,
  );
  assert.equal(
    showAgentDriverInstallHint(
      "oracle",
      [
        { db_type: "oracle", installed: true },
        { db_type: "oracle-legacy", installed: false },
        { db_type: "oracle-10g", installed: false },
      ],
      "oracle",
    ),
    false,
  );
  assert.equal(
    showAgentDriverInstallHint(
      "oracle",
      [
        { db_type: "oracle", installed: true },
        { db_type: "oracle-legacy", installed: true },
        { db_type: "oracle-10g", installed: false },
      ],
      "oracle-legacy",
    ),
    false,
  );
  assert.equal(showAgentDriverInstallHint("oracle", [{ db_type: "oracle", installed: false }], "oracle"), true);
});

test("uses selected non-Oracle agent driver profiles for install hints", () => {
  assert.equal(
    showAgentDriverInstallHint(
      "gbase",
      [
        { db_type: "gbase", installed: true },
        { db_type: "gbase8s", installed: false },
      ],
      "gbase8s",
    ),
    true,
  );
  assert.equal(
    showAgentDriverInstallHint(
      "gbase",
      [
        { db_type: "gbase", installed: false },
        { db_type: "gbase8s", installed: true },
      ],
      "gbase8s",
    ),
    false,
  );
});
