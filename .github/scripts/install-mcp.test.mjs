import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const installer = resolve("docs/public/install-mcp.sh");
const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64-gnu", "linux-x64-gnu"];

function fixture(context, platform = "darwin-arm64") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dbx-mcp-test-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "DBX User's 中文");
  const mocks = join(root, "mocks");
  const source = join(root, "source");
  mkdirSync(home);
  mkdirSync(mocks);
  mkdirSync(join(source, "package/bin"), { recursive: true });
  const binary = join(source, "package/bin/dbx-mcp");
  writeFileSync(binary, "#!/bin/sh\nprintf 'dbx-mcp 0.4.96\\n'\n", { mode: 0o755 });
  copyFileSync(binary, join(source, "dbx-mcp"));
  for (const [archive, member] of [["npm.tgz", "package/bin/dbx-mcp"], ["github.tar.gz", "dbx-mcp"]]) {
    const result = spawnSync("tar", ["-czf", join(root, archive), "-C", source, member]);
    assert.equal(result.status, 0, result.stderr.toString());
  }
  const integrity = "sha512-" + createHash("sha512").update(readFileSync(join(root, "npm.tgz"))).digest("base64");
  const checksum = createHash("sha256").update(readFileSync(join(root, "github.tar.gz"))).digest("hex");
  writeFileSync(join(root, "latest.json"), JSON.stringify({ description: 'ignore "version":"99.0.0"', version: "0.4.96" }));
  writeFileSync(join(root, "metadata.json"), JSON.stringify({ name: "test", version: "0.4.96", dist: { integrity } }));
  writeFileSync(join(root, "refs.json"), JSON.stringify([
    { ref: "refs/tags/packages-v0.4.9", object: {} },
    { ref: "refs/tags/packages-v0.4.96", object: {} },
    { ref: "refs/tags/packages-v1.0.0-beta.1", object: {} },
    { ref: "refs/tags/packages-v0.4.10", object: {} },
  ]));
  writeFileSync(join(root, "SHA256SUMS"), `${checksum}  dbx-mcp-${platform}.tar.gz\n`);
  const routes = {};
  for (const registry of ["https://registry.npmjs.org", "https://registry.npmmirror.com"]) {
    routes[`${registry}/@dbx-app/mcp-server/latest`] = "latest.json";
    routes[`${registry}/@dbx-app/mcp-${platform}/0.4.96`] = "metadata.json";
    routes[`${registry}/@dbx-app/mcp-${platform}/-/mcp-${platform}-0.4.96.tgz`] = "npm.tgz";
  }
  routes["https://api.github.com/repos/t8y2/dbx/git/matching-refs/tags/packages-v"] = "refs.json";
  routes["https://github.com/t8y2/dbx/releases/download/packages-v0.4.96/SHA256SUMS"] = "SHA256SUMS";
  routes[`https://github.com/t8y2/dbx/releases/download/packages-v0.4.96/dbx-mcp-${platform}.tar.gz`] = "github.tar.gz";
  writeFileSync(join(root, "routes.json"), JSON.stringify(routes));
  writeFileSync(join(mocks, "curl"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith('https://'));
const root = process.env.FIXTURE;
fs.appendFileSync(path.join(root, 'requests.log'), url + '\\n');
if (process.env.FAIL_URL && new RegExp(process.env.FAIL_URL).test(url)) process.exit(22);
const routes = JSON.parse(fs.readFileSync(path.join(root, 'routes.json')));
if (!routes[url]) process.exit(22);
fs.copyFileSync(path.join(root, routes[url]), args[args.indexOf('-o') + 1]);
`, { mode: 0o755 });
  writeFileSync(join(mocks, "uname"), `#!/bin/sh\ncase "$1" in -s) echo '${platform.startsWith("darwin") ? "Darwin" : "Linux"}';; -m) echo '${platform.includes("arm64") ? "aarch64" : "x86_64"}';; esac\n`, { mode: 0o755 });
  const installedBinary = join(home, ".dbx/bin/dbx-mcp");
  const marker = join(home, ".dbx/bin/.dbx-mcp-version");
  const run = (extra = {}) => spawnSync("sh", [installer], {
    env: { ...process.env, HOME: home, SHELL: "/bin/zsh", ZDOTDIR: home, PATH: `${mocks}:${process.env.PATH}`, FIXTURE: root, ...extra },
    encoding: "utf8", timeout: 30_000,
  });
  return { root, home, mocks, binary: installedBinary, marker, run };
}

for (const platform of platforms) {
  test(`native install and absolute configs: ${platform}`, (context) => {
    const setup = fixture(context, platform);
    const result = setup.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(spawnSync(setup.binary, ["--version"], { encoding: "utf8" }).stdout.trim(), "dbx-mcp 0.4.96");
    assert.equal(readFileSync(setup.marker, "utf8"), "0.4.96\n");
    const json = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"mcpServers"')));
    assert.equal(json.mcpServers.dbx.command, setup.binary);
    const tomlCommand = result.stdout.split("\n").find((line) => line.startsWith("command = ")).slice(10);
    assert.equal(JSON.parse(tomlCommand), setup.binary);
    assert.deepEqual(readdirSync(join(setup.home, ".dbx/bin")).sort(), [".dbx-mcp-version", "dbx-mcp"]);
  });
}

test("rerun is idempotent, binary version precedes marker, legacy marker enables update", (context) => {
  const setup = fixture(context);
  assert.equal(setup.run().status, 0);
  writeFileSync(setup.marker, "0.4.95\n");
  const unchanged = setup.run();
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.match(unchanged.stdout, /dbx-mcp 0.4.96 already up to date/);
  assert.equal(readFileSync(setup.marker, "utf8"), "0.4.95\n");
  writeFileSync(setup.binary, "#!/bin/sh\nprintf 'dbx-mcp 0.4.96\\n'\nexit 1\n");
  const updated = setup.run();
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, /Installed dbx-mcp 0.4.96/);
  assert.equal(readFileSync(setup.marker, "utf8"), "0.4.96\n");
  writeFileSync(setup.binary, "#!/bin/sh\nexit 1\n");
  assert.match(setup.run().stdout, /already up to date/);
  assert.equal(readFileSync(join(setup.home, ".zshrc"), "utf8").match(/# added by dbx installer/g).length, 1);
});

for (const [name, failUrl, expected] of [
  ["npmmirror", "registry\\.npmjs\\.org", "registry.npmmirror.com"],
  ["GitHub", "registry\\.", "github.com/t8y2/dbx/releases/download/packages-v0.4.96"],
]) {
  test(`falls back to ${name} for metadata and archive`, (context) => {
    const setup = fixture(context);
    const result = setup.run({ FAIL_URL: failUrl });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(join(setup.root, "requests.log"), "utf8").includes(expected));
  });
}

test("download fallback retains the version selected by npmjs", (context) => {
  const setup = fixture(context);
  const result = setup.run({ FAIL_URL: "registry\\.npmjs\\.org/.*mcp-darwin" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(setup.root, "requests.log"), "utf8"), /npmmirror.com\/.*0.4.96.tgz/);
});

test("an older mirror version cannot downgrade an existing native installation", (context) => {
  const setup = fixture(context);
  assert.equal(setup.run().status, 0);
  const newer = "#!/bin/sh\nprintf 'dbx-mcp 0.4.97\\n'\n";
  writeFileSync(setup.binary, newer);
  writeFileSync(setup.marker, "0.4.97\n");
  const result = setup.run({ FAIL_URL: "registry\\.npmjs\\.org" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /keeping current installation/);
  assert.equal(readFileSync(setup.binary, "utf8"), newer);
  assert.equal(readFileSync(setup.marker, "utf8"), "0.4.97\n");
});

test("offline exits with one concise error and preserves the existing installation", (context) => {
  const setup = fixture(context);
  assert.equal(setup.run().status, 0);
  const original = readFileSync(setup.binary);
  const result = setup.run({ FAIL_URL: ".*" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim().split("\n").length, 1);
  assert.match(result.stderr, /existing installation unchanged/);
  assert.deepEqual(readFileSync(setup.binary), original);
});

for (const source of ["npm", "github"]) {
  test(`rejects ${source} checksum mismatch without replacing anything`, (context) => {
    const setup = fixture(context);
    mkdirSync(join(setup.home, ".dbx/bin"), { recursive: true });
    writeFileSync(setup.binary, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(setup.marker, "0.4.95\n");
    const original = readFileSync(setup.binary);
    writeFileSync(join(setup.root, source === "npm" ? "npm.tgz" : "github.tar.gz"), "corrupted");
    const result = setup.run(source === "github" ? { FAIL_URL: "registry\\." } : {});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /verification failed/);
    assert.deepEqual(readFileSync(setup.binary), original);
    assert.equal(readFileSync(setup.marker, "utf8"), "0.4.95\n");
    assert.ok(!existsSync(join(setup.home, ".zshrc")));
  });
}

test("stale marker without binary reinstalls, and bash users get migration guidance", (context) => {
  const setup = fixture(context);
  mkdirSync(join(setup.home, ".dbx/bin"), { recursive: true });
  writeFileSync(setup.marker, "0.4.96\n");
  writeFileSync(join(setup.mocks, "dbx-mcp-server"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = setup.run({ SHELL: "/bin/bash" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(setup.binary));
  assert.ok(existsSync(join(setup.home, ".bash_profile")));
  assert.match(result.stdout, /npm rm -g @dbx-app\/mcp-server/);
});

test("formula generator validates all hashes and both publishing workflows invoke it", (context) => {
  const setup = fixture(context);
  const sums = join(setup.root, "formula-sums");
  const output = join(setup.root, "dbx-mcp.rb");
  writeFileSync(sums, platforms.map((platform) => `${"a".repeat(64)}  dbx-mcp-${platform}.tar.gz`).join("\n"));
  const generate = () => spawnSync(process.execPath, [".github/scripts/render-mcp-formula.mjs", "0.4.96", sums, output], { encoding: "utf8" });
  assert.equal(generate().status, 0);
  const formula = readFileSync(output, "utf8");
  assert.match(formula, /bin.install "dbx-mcp"/);
  assert.doesNotMatch(formula, /__[A-Z_]+__/);
  assert.equal((formula.match(/sha256 /g) ?? []).length, 4);
  writeFileSync(sums, "invalid");
  assert.notEqual(generate().status, 0);
  assert.equal(readFileSync(output, "utf8"), formula);
  for (const workflow of ["mcp-release", "publish-packages"]) {
    const text = readFileSync(`.github/workflows/${workflow}.yml`, "utf8");
    const checkoutIndex = text.indexOf("actions/checkout@");
    const renderIndex = text.indexOf("render-mcp-formula.mjs");
    assert.notEqual(checkoutIndex, -1);
    assert.notEqual(renderIndex, -1);
    assert.ok(checkoutIndex < renderIndex);
    assert.match(text, /render-mcp-formula.mjs/);
    assert.match(text, /git add .*Formula\/dbx-mcp.rb/);
  }
});
