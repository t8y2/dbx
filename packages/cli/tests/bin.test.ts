import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const cliSource = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("prints version when invoked through an npm-style symlink", async () => {
  const bin = await symlinkedCli();
  try {
    const result = runDbx(bin, ["--version"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
    assert.equal(result.stderr, "");
  } finally {
    await rm(bin.dir, { recursive: true, force: true });
  }
});

test("prints capabilities when invoked through an npm-style symlink", async () => {
  const bin = await symlinkedCli();
  try {
    const result = runDbx(bin, ["capabilities", "--json"]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout) as { directQueryTypes: string[]; bridgeRequiredTypes: string[] };
    assert.ok(payload.directQueryTypes.includes("postgres"));
    assert.ok(payload.directQueryTypes.includes("rqlite"));
    assert.ok(payload.bridgeRequiredTypes.includes("oracle"));
  } finally {
    await rm(bin.dir, { recursive: true, force: true });
  }
});

async function symlinkedCli() {
  const dir = await mkdtemp(join(tmpdir(), "dbx-cli-bin-"));
  const path = join(dir, "dbx");
  await symlink(cliSource, path);
  return { dir, path };
}

function runDbx(bin: { path: string }, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", bin.path, ...args], {
    cwd: packageDir,
    encoding: "utf-8",
  });
}
