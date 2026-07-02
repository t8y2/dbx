import assert from "node:assert/strict";
import { test } from "vitest";
import { appendAgentDriverUpdateHint, hasAgentDriverUpdate, showAgentDriverInstallHint } from "../../apps/desktop/src/lib/agentDriverInstallHint.ts";

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
  assert.equal(showAgentDriverInstallHint("oracle", [{ db_type: "oracle", installed: false }], "oracle-10g"), true);
  assert.equal(showAgentDriverInstallHint("oracle", [{ db_type: "oracle", installed: true }], "oracle"), false);
  assert.equal(showAgentDriverInstallHint("oracle", [{ db_type: "oracle", installed: true }], "oracle-legacy"), false);
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

test("detects available updates for the selected agent driver", () => {
  assert.equal(hasAgentDriverUpdate("dameng", [{ db_type: "dameng", installed: true, update_available: true }], "dm"), true);
  assert.equal(hasAgentDriverUpdate("dameng", [{ db_type: "dameng", installed: true, update_available: false }], "dm"), false);
  assert.equal(hasAgentDriverUpdate("mysql", [{ db_type: "mysql", installed: true, update_available: true }]), false);
});

test("uses unified Oracle and selected profile keys for update hints", () => {
  assert.equal(hasAgentDriverUpdate("oracle", [{ db_type: "oracle", installed: true, update_available: true }], "oracle-10g"), true);
  assert.equal(
    hasAgentDriverUpdate(
      "gbase",
      [
        { db_type: "gbase", installed: true, update_available: false },
        { db_type: "gbase8s", installed: true, update_available: true },
      ],
      "gbase8s",
    ),
    true,
  );
});

test("appends agent driver update hints once", () => {
  const hint = "Driver update available.";
  assert.equal(appendAgentDriverUpdateHint("Original error", hint), "Original error\n\nDriver update available.");
  assert.equal(appendAgentDriverUpdateHint("Original error\n\nDriver update available.", hint), "Original error\n\nDriver update available.");
  assert.equal(appendAgentDriverUpdateHint("", hint), hint);
});
