import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyStableAliases, stableAliasPairs } from "./stable-asset-aliases.mjs";

const tag = "v0.6.63-beta.20261101.3";

test("a plain stable tag has no aliases", () => {
  assert.deepEqual(stableAliasPairs("v0.6.63"), []);
});

test("a beta tag aliases every user-facing package to the stable file name", () => {
  const pairs = new Map(stableAliasPairs(tag));
  assert.equal(pairs.get("DBX_0.6.63-beta.20261101.3_x64-setup.exe"), "DBX_0.6.63_x64-setup.exe");
  assert.equal(pairs.get("DBX_0.6.63-beta.20261101.3_amd64.AppImage"), "DBX_0.6.63_amd64.AppImage");
  assert.equal(pairs.get("DBX_0.6.63-beta.20261101.3_amd64.deb"), "DBX_0.6.63_amd64.deb");
  assert.equal(pairs.get("DBX-0.6.63-beta.20261101.3-1.x86_64.rpm"), "DBX-0.6.63-1.x86_64.rpm");
});

test("applying aliases copies the packages and tolerates an existing alias", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dbx-aliases-"));
  for (const [source] of stableAliasPairs(tag)) await writeFile(join(directory, source), source);
  await writeFile(join(directory, "DBX_0.6.63_x64-setup.exe"), "already there");

  const created = applyStableAliases(tag, directory);
  assert.equal(created.length, stableAliasPairs(tag).length - 1);
  assert.ok((await readdir(directory)).includes("DBX-0.6.63-1.x86_64.rpm"));
  assert.deepEqual(applyStableAliases(tag, directory), []);
});

test("applying aliases fails when a beta package is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dbx-aliases-"));
  assert.throws(() => applyStableAliases(tag, directory), /Missing beta package asset/);
});
