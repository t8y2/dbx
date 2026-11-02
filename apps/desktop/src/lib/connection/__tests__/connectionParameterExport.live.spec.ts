/** Opt-in compatibility check against an existing encrypted DBX export. No credentials are written or printed. */
import { readFileSync } from "node:fs";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { describe, it } from "vitest";
import { connectionParameterSyntax } from "../connectionParameterCatalog";
import { parseConnectionParameters, writeConnectionParameters } from "../connectionParameterDocument";

const exportPath = process.env.DBX_PARAMETER_EXPORT_FILE;
const passphrase = process.env.DBX_PARAMETER_EXPORT_PASSPHRASE;
describe.skipIf(!exportPath || !passphrase)("existing encrypted DBX connection export", () => {
  it("preserves all original parameter bytes for every exported connection", () => {
    const payload = JSON.parse(readFileSync(exportPath!, "utf8"));
    const key = pbkdf2Sync(passphrase!, Buffer.from(payload.salt, "base64"), 100000, 32, "sha256");
    const data = Buffer.from(payload.data, "base64");
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    cipher.setAuthTag(data.subarray(-16));
    const plaintext = JSON.parse(Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]).toString("utf8"));
    const configs = Array.isArray(plaintext) ? plaintext : plaintext.connections;
    if (!Array.isArray(configs) || !configs.length) throw new Error("Export contains no connections");
    let withParameters = 0;
    for (let index = 0; index < configs.length; index++) {
      const config = configs[index];
      const source = typeof config.url_params === "string" ? config.url_params : "";
      if (source) withParameters++;
      const document = parseConnectionParameters(source, connectionParameterSyntax(config));
      const result = writeConnectionParameters(document, document.entries);
      if (result.errors.length || result.value !== source) throw new Error(`Round-trip failed for connection index ${index} (${config.db_type}); parameter contents omitted`);
      const added = writeConnectionParameters(document, [...document.entries, { id: "temporary-compatibility-probe", key: "DBX_EDITOR_COMPAT_TEST", value: "probe", editable: true, hasEquals: true }]);
      if (added.errors.length || !added.value.startsWith(source)) throw new Error(`Appending a parameter changed the original prefix for index ${index}; contents omitted`);
    }
    if (withParameters === 0) throw new Error("Export has no existing parameters to verify");
  });
});
