import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const connectionDialogSource = readFileSync(new URL("../ConnectionDialog.vue", import.meta.url), "utf8");

describe("MQTT TLS switch bindings", () => {
  it("uses the Switch component's controlled model API", () => {
    expect(connectionDialogSource).toContain('<Switch v-model="mqttTls" />');
    expect(connectionDialogSource).toContain('<Switch v-model="mqttTlsSkipVerify" class="ml-4" />');
    expect(connectionDialogSource).not.toContain("@update:checked");
  });
});
