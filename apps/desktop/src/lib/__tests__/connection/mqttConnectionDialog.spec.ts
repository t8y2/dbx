import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");
const mqttSectionStart = dialogSource.indexOf("<template v-else-if=\"form.db_type === 'mqtt'\">");
const mqttSectionEnd = dialogSource.indexOf("<template v-else-if=\"form.db_type === 'victoriametrics'\">", mqttSectionStart);
const mqttSection = dialogSource.slice(mqttSectionStart, mqttSectionEnd);

describe("MQTT connection dialog", () => {
  it("binds TLS switches through the shared Switch model API", () => {
    expect(mqttSection).toContain('<Switch v-model="mqttTls" />');
    expect(mqttSection).toContain('<Switch v-model="mqttTlsSkipVerify" class="ml-4" />');
    expect(mqttSection).not.toContain(":checked=");
    expect(mqttSection).not.toContain("@update:checked=");
  });

  it("serializes both TLS choices into the MQTT external config", () => {
    expect(dialogSource).toContain("tls: mqttTls.value");
    expect(dialogSource).toContain("tlsSkipVerify: mqttTlsSkipVerify.value");
  });
});
