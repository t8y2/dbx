import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, mkdir, writeFile, copyFile, readFile, stat, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { packagePlugin, hostTarget } from "./package-codex-plugin.mjs";

let root;
let binaries;
const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const suffix = process.platform === "win32" ? ".exe" : "";
async function fixture(directory, fixtureVersion = version, embedded = true) {
  await mkdir(directory, { recursive: true });
  const source = join(directory, "fixture.rs");
  await writeFile(source, `fn main() { let path=std::env::current_exe().unwrap(); let name=path.file_stem().unwrap().to_str().unwrap(); if std::env::args().any(|arg| arg=="--codex-package-check") { println!(r#"{{"version":"${fixtureVersion}","embedded_frontend":${embedded},"full_features":true}}"#); } else { println!("{} ${fixtureVersion}", name); } }`);
  const result = spawnSync("rustc", [source, "-o", join(directory, `dbx-codex${suffix}`)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  await copyFile(join(directory, `dbx-codex${suffix}`), join(directory, `dbx-web${suffix}`));
  return directory;
}
before(async () => {
  root = await mkdtemp(join(tmpdir(), "dbx plugin package "));
  binaries = await fixture(join(root, "input binaries"));
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test("rejects missing binaries without creating an output", async () => {
  const output = join(root, "missing output");
  await assert.rejects(packagePlugin({ target: hostTarget(), binaries: root, output }), /dbx-codex.*missing|ENOENT/);
  await assert.rejects(stat(output), /ENOENT/);
});

test("rejects an incompatible binary version", async () => {
  const bad = await fixture(join(root, "bad binaries"), "0.0.0");
  await assert.rejects(packagePlugin({ target: hostTarget(), binaries: bad, output: join(root, "bad output") }), /version/);
});

test("rejects a Web binary without embedded frontend assets", async () => {
  const incomplete = await fixture(join(root, "incomplete binaries"), version, false);
  await assert.rejects(packagePlugin({ target: hostTarget(), binaries: incomplete, output: join(root, "incomplete output") }), /embedded|features/);
});

test("refuses to overwrite an existing output directory", async () => {
  const output = join(root, "existing");
  await mkdir(output);
  await writeFile(join(output, "keep.txt"), "keep");
  await assert.rejects(packagePlugin({ target: hostTarget(), binaries, output }), /exist/);
  assert.equal(await readFile(join(output, "keep.txt"), "utf8"), "keep");
});

test("packages relocatable executables, relative metadata and a checksummed archive", async () => {
  const output = join(root, "packaged output");
  await packagePlugin({ target: hostTarget(), binaries, output });
  const moved = join(root, "relocated output");
  await rename(output, moved);
  const plugin = join(moved, "plugins", "dbx");
  const manifest = JSON.parse(await readFile(join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.version, version);
  assert.equal(manifest.mcpServers, "./.mcp.json");
  const mcp = JSON.parse(await readFile(join(plugin, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.dbx.command, `./bin/dbx-codex${suffix}`);
  assert.equal(mcp.mcpServers.dbx.cwd, ".");
  assert.ok(!JSON.stringify({ manifest, mcp }).includes(root));
  const result = spawnSync(mcp.mcpServers.dbx.command, ["--version"], { cwd: plugin, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `dbx-codex ${version}`);
  if (process.platform !== "win32") assert.equal((await stat(join(plugin, "bin", "dbx-codex"))).mode & 0o111, 0o111);
  const marketplace = JSON.parse(await readFile(join(moved, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins[0].source.path, "./plugins/dbx");
  const sums = await readFile(join(moved, "SHA256SUMS"), "utf8");
  assert.match(sums, /[a-f0-9]{64}  dbx-codex-.*\.tar\.gz/);
  assert.ok((await stat(join(moved, sums.trim().split("  ")[1]))).size > 0);
  assert.ok((await stat(join(plugin, "LICENSE"))).size > 0);
  assert.match(await readFile(join(plugin, "README.md"), "utf8"), /codex plugin add dbx@dbx-local/);
  assert.match(await readFile(join(plugin, "README.zh-CN.md"), "utf8"), /confirm_interrupt=true/);
});
