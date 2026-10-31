import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { msiConfigForTag } from "./prepare-msi-config.mjs";

const script = fileURLToPath(new URL("./prepare-msi-config.mjs", import.meta.url));

test("stable tags leave the MSI version to the app version", () => {
  assert.deepEqual(msiConfigForTag("v0.6.60"), {});
});

test("beta tags get a numeric MSI version derived from the build date and sequence", () => {
  const wixVersion = (tag) => msiConfigForTag(tag).bundle.windows.wix.version;
  assert.equal(wixVersion("v0.6.60-beta.20261029.1"), "0.6.60.30201");
  assert.equal(wixVersion("v0.6.60-beta.20260101.1"), "0.6.60.101");
  assert.equal(wixVersion("v0.6.60-beta.20261231.99"), "0.6.60.36599");
  assert.equal(wixVersion("v0.6.60-beta.20240229.2"), "0.6.60.6002");
});

test("every beta MSI build number fits the 65535 field limit", () => {
  const { version } = msiConfigForTag("v255.255.65535-beta.20261231.99").bundle.windows.wix;
  assert.ok(Number(version.split(".")[3]) <= 65535);
});

test("rejects tags the MSI version cannot represent", () => {
  assert.throws(() => msiConfigForTag("v0.6.60-beta.20261029.100"), /1-99/);
  assert.throws(() => msiConfigForTag("v0.6.60-beta.20261029.0"), /1-99/);
  assert.throws(() => msiConfigForTag("v0.6.60-beta.20261329.1"), /Invalid beta build date/);
  assert.throws(() => msiConfigForTag("v256.0.0-beta.20261029.1"), /limits/);
  assert.throws(() => msiConfigForTag("v0.6.60-rc.1"), /Unsupported release tag/);
});

test("writes the config file for the Tauri CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dbx-msi-config-"));
  const output = join(dir, "tauri.msi.conf.json");
  const result = spawnSync(process.execPath, [script, "v0.6.60-beta.20261029.1", output], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
    bundle: { windows: { wix: { version: "0.6.60.30201" } } },
  });
  const failed = spawnSync(process.execPath, [script, "main", output], { encoding: "utf8" });
  assert.equal(failed.status, 1);
});
