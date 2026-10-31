import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const script = fileURLToPath(new URL("./prepare-channel-manifest.mjs", import.meta.url));

async function run(args) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, stderr };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dbx-channel-manifest-"));
  const input = join(root, "input.json");
  const output = join(root, "output.json");
  await writeFile(input, JSON.stringify({ version: "0.6.60", platforms: { "darwin-aarch64": {} } }));
  return { input, output };
}

test("writes channel and promotion metadata", async () => {
  const { input, output } = await fixture();
  const result = await run([input, output, "beta", "v0.6.60-beta.20261028.1", "false", "2026-10-28T00:00:00.000Z"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
    version: "0.6.60-beta.20261028.1",
    platforms: { "darwin-aarch64": {} },
    channel: "beta",
    release_tag: "v0.6.60-beta.20261028.1",
    is_promoted: false,
    published_at: "2026-10-28T00:00:00.000Z",
  });
});

test("promotes a beta manifest back to the stable base version", async () => {
  const { input, output } = await fixture();
  await writeFile(input, JSON.stringify({ version: "0.6.60-beta.20261028.1", platforms: {} }));
  const result = await run([input, output, "stable", "v0.6.60-beta.20261028.1", "true", "2026-10-28T00:00:00.000Z"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(output, "utf8")).version, "0.6.60");
});

test("preserves an existing published_at", async () => {
  const { input, output } = await fixture();
  await writeFile(input, JSON.stringify({ version: "0.6.60", platforms: {}, published_at: "2026-10-27T00:00:00.000Z" }));
  const result = await run([input, output, "stable", "v0.6.60", "true", "2026-10-28T00:00:00.000Z"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(output, "utf8")).published_at, "2026-10-27T00:00:00.000Z");
});

test("fixed published_at makes repeated promotion deterministic", async () => {
  const first = await fixture();
  const second = await fixture();
  const args = ["stable", "v0.6.60", "true", "2026-10-28T00:00:00.000Z"];
  assert.equal((await run([first.input, first.output, ...args])).code, 0);
  assert.equal((await run([second.input, second.output, ...args])).code, 0);
  assert.equal(await readFile(first.output, "utf8"), await readFile(second.output, "utf8"));
});

test("rejects invalid channel, tag, and promotion flag", async () => {
  const { input, output } = await fixture();
  for (const args of [
    ["canary", "v0.6.60", "false"],
    ["stable", "0.6.60", "true"],
    ["stable", "v0.6.60", "yes"],
    ["beta", "v0.6.60", "false"],
  ]) {
    const result = await run([input, output, ...args]);
    assert.notEqual(result.code, 0);
  }
});

test("rejects a tag whose base version differs from the built manifest", async () => {
  const { input, output } = await fixture();
  const result = await run([input, output, "beta", "v0.6.61-beta.20261028.1", "false"]);
  assert.notEqual(result.code, 0);
});

test("rejects a beta manifest with a stable tag", async () => {
  const { input, output } = await fixture();
  const result = await run([input, output, "beta", "v0.6.60", "false"]);
  assert.notEqual(result.code, 0);
});
