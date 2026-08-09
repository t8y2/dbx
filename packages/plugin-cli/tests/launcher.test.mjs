import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(packageRoot, "bin", "dbx-plugin.js");
const stageSdk = join(packageRoot, "scripts", "stage-sdk.mjs");
const sdkRoot = join(packageRoot, "sdk-root");

test("forwards arguments and provides the bundled SDK root", () => {
  const stage = spawnSync(process.execPath, [stageSdk], { encoding: "utf8" });
  assert.equal(stage.status, 0, stage.stderr);
  try {
    const result = spawnSync(
      process.execPath,
      [launcher, "-e", "process.stdout.write(process.env.DBX_PLUGIN_SDK_ROOT || '')"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DBX_PLUGIN_CLI_BINARY: process.execPath,
          DBX_PLUGIN_SDK_ROOT: "",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, sdkRoot);
    assert.ok(existsSync(join(sdkRoot, "plugins", "sdk", "rust", "dbx-plugin-sdk", "Cargo.toml")));
    assert.ok(existsSync(join(sdkRoot, "plugins", "sdk", "go", "dbx-plugin-sdk", "go.mod")));
  } finally {
    rmSync(sdkRoot, { recursive: true, force: true });
  }
});

test("preserves an explicit SDK root", () => {
  const result = spawnSync(
    process.execPath,
    [launcher, "-e", "process.stdout.write(process.env.DBX_PLUGIN_SDK_ROOT || '')"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DBX_PLUGIN_CLI_BINARY: process.execPath,
        DBX_PLUGIN_SDK_ROOT: "/custom/dbx-plugin-sdk",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "/custom/dbx-plugin-sdk");
});

test("rejects a missing binary override", () => {
  const missing = join(packageRoot, "missing-dbx-plugin-binary");
  const result = spawnSync(process.execPath, [launcher, "--version"], {
    encoding: "utf8",
    env: { ...process.env, DBX_PLUGIN_CLI_BINARY: missing },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DBX_PLUGIN_CLI_BINARY does not exist/);
});
