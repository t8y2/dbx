import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname;
const releaseScript = join(repoRoot, "scripts/release.mjs");

function runRelease(args, env = {}) {
  return spawnSync(process.execPath, [releaseScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
}

function createMockGh() {
  const directory = mkdtempSync(join(tmpdir(), "dbx-release-test-"));
  const ghPath = join(directory, "gh");
  writeFileSync(
    ghPath,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      "",
      "const args = process.argv.slice(2);",
      'if (args[0] === "auth" || (args[0] === "workflow" && args[1] === "view")) process.exit(0);',
      'if (args[0] === "workflow" && args[1] === "run") {',
      '  appendFileSync(process.env.GH_LOG, args.join(" ") + "\\n");',
      "  process.exit(0);",
      "}",
      'if (args[0] === "release" && args[1] === "view") {',
      '  const explicitTag = args[2]?.startsWith("v") ? args[2] : null;',
      "  const tagName = explicitTag ?? process.env.MOCK_LATEST_TAG;",
      "  const version = tagName.slice(1);",
      "  const assets = [",
      '    "latest.json",',
      '    "DBX_" + version + "_aarch64.dmg",',
      '    "DBX_" + version + "_x64.dmg",',
      '    "DBX_" + version + "_x64-setup.exe",',
      '    "DBX_" + version + "_arm64-setup.exe",',
      "  ].map((name) => ({ name }));",
      '  process.stdout.write(JSON.stringify({ tagName, isDraft: false, isPrerelease: false, publishedAt: "2026-07-21T00:00:00Z", assets }));',
      "  process.exit(0);",
      "}",
      'process.stderr.write("Unexpected gh command: " + args.join(" "));',
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  chmodSync(ghPath, 0o755);
  return directory;
}

test("rollback dry-run prints all affected channels without invoking GitHub", () => {
  const result = runRelease(["rollback", "v0.5.63", "--dry-run", "--skip-fetch"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Emergency app rollback/);
  assert.match(result.stdout, /publish-packages\.yml.*notify=false/);
  assert.match(result.stdout, /sync-cnb-release-assets\.yml/);
  assert.match(result.stdout, /rollback-docker-latest\.yml/);
  assert.match(result.stdout, /does not downgrade clients/);
});

test("rollback dispatches each distribution workflow after validation", () => {
  const mockBin = createMockGh();
  const logPath = join(mockBin, "gh.log");
  const result = runRelease(["rollback", "v0.5.63", "--yes", "--skip-fetch"], {
    PATH: `${mockBin}:${process.env.PATH}`,
    GH_LOG: logPath,
    MOCK_LATEST_TAG: "v0.5.64",
  });

  assert.equal(result.status, 0, result.stderr);
  const commands = readFileSync(logPath, "utf8").trim().split("\n");
  assert.deepEqual(commands, [
    "workflow run publish-packages.yml --repo t8y2/dbx -f tag=v0.5.63 -f notify=false",
    "workflow run sync-cnb-release-assets.yml --repo t8y2/dbx -f tag=v0.5.63",
    "workflow run rollback-docker-latest.yml --repo t8y2/dbx -f tag=v0.5.63",
  ]);
});

test("rollback rejects a target that is not older than latest", () => {
  const mockBin = createMockGh();
  const logPath = join(mockBin, "gh.log");
  const result = runRelease(["rollback", "v0.5.64", "--yes", "--skip-fetch"], {
    PATH: `${mockBin}:${process.env.PATH}`,
    GH_LOG: logPath,
    MOCK_LATEST_TAG: "v0.5.64",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be older than the current latest release v0\.5\.64/);
});

test("rollback rejects prerelease tag syntax", () => {
  const result = runRelease(["rollback", "v0.5.63-rc.1", "--dry-run", "--skip-fetch"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /only supports stable vX\.Y\.Z app releases/);
});
