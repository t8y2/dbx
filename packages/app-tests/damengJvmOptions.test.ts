import assert from "node:assert/strict";
import { test } from "vitest";
import { DamengJvmSystemPropertyError, damengJvmSystemPropertiesText, parseDamengJvmSystemProperties } from "../../apps/desktop/src/lib/database/damengJvmOptions.ts";

test("normalizes Dameng JVM system properties and preserves spaces in values", () => {
  assert.deepEqual(parseDamengJvmSystemProperties("\n  -Djava.net.preferIPv4Stack  \r\n-Ddm.config.path=C:\\Program Files\\DM\\dm.ini\n"), ["-Djava.net.preferIPv4Stack", "-Ddm.config.path=C:\\Program Files\\DM\\dm.ini"]);
});

test("rejects JVM launcher options and empty property keys", () => {
  for (const option of ["-jar", "-javaagent:agent.jar", "-agentpath:agent.dll", "-Xmx1g", "-D", "-D=value"]) {
    assert.throws(() => parseDamengJvmSystemProperties(option), DamengJvmSystemPropertyError);
  }
});

test("rejects shell quotes instead of preserving them in the property value", () => {
  assert.throws(() => parseDamengJvmSystemProperties('-Ddm.config.path="C:\\Program Files\\DM\\dm.ini"'), DamengJvmSystemPropertyError);
});

test("hydrates missing legacy options as an empty form value", () => {
  assert.equal(damengJvmSystemPropertiesText(undefined), "");
  assert.equal(damengJvmSystemPropertiesText(["", "  -Dkey=value  "]), "-Dkey=value");
});
