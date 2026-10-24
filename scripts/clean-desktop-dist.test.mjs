import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("cleans only the script's desktop dist directory, even from another cwd", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "dbx-clean-desktop-dist-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, "scripts");
  const dist = path.join(root, "dist");
  const assets = path.join(dist, "assets");
  const other = path.join(root, "other");
  await mkdir(scripts);
  await mkdir(assets, { recursive: true });
  await mkdir(path.join(other, "dist"), { recursive: true });
  await copyFile(new URL("./clean-desktop-dist.mjs", import.meta.url), path.join(scripts, "clean-desktop-dist.mjs"));
  await writeFile(path.join(assets, "stale.js"), "stale");
  const unrelated = path.join(other, "dist", "keep.txt");
  await writeFile(unrelated, "keep");

  const run = () => execFileAsync(process.execPath, [path.join(scripts, "clean-desktop-dist.mjs")], { cwd: other });
  await run();
  await assert.rejects(access(dist), { code: "ENOENT" });
  assert.equal(await readFile(unrelated, "utf8"), "keep");
  await run();
  assert.equal(await readFile(unrelated, "utf8"), "keep");
});
