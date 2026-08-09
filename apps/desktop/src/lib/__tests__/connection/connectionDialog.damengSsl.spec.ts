import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");
const tlsCapableDatabaseTypesSource = dialogSource.match(/const tlsCapableDatabaseTypes = new Set<DatabaseType>\(\[([\s\S]*?)\]\);/)?.[1] ?? "";

describe("Dameng SSL connection form", () => {
  it("shows Dameng in the TLS tab with certificate directory and password fields", () => {
    expect(tlsCapableDatabaseTypesSource).toContain('"dameng"');
    expect(dialogSource).toContain("<template v-if=\"form.db_type === 'dameng'\">");
    expect(dialogSource).toContain('v-model="damengSslFilesPath"');
    expect(dialogSource).toContain('v-model="damengSslKeystorePassword"');
    expect(dialogSource).toContain('v-model="damengSslProtocol"');
    expect(dialogSource).toContain('t("connection.damengSslVerificationHint")');
  });
});
